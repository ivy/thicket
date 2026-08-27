import { request as httpRequest } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { Readable } from "node:stream";
import { connect as tlsConnect } from "node:tls";

const BANNER_LIMIT = 8192;

/**
 * A fetch that leaves through netd's egress socket.
 *
 * netd runs an HTTP forward proxy there and dials via the tailnet, so
 * everything reachable through this function is a tailnet peer and nothing
 * else — not the public internet, not localhost, not a metadata endpoint.
 * That containment is what lets a URL arriving in an inbound message be
 * fetched at all, without an allow-list to write and keep true.
 *
 * Every request goes through a CONNECT tunnel, https included, so TLS is
 * terminated by the peer rather than by the proxy: netd moves bytes it
 * cannot read.
 */
export function egressFetch(socketPath: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const port = url.port === "" ? (url.protocol === "http:" ? 80 : 443) : Number(url.port);
    const socket = await tunnel(socketPath, url.hostname, port, url.protocol === "https:");
    return await new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        {
          createConnection: () => socket,
          agent: false,
          method: init?.method ?? "GET",
          path: `${url.pathname}${url.search}`,
          headers: { host: url.host, ...headersOf(init) },
        },
        (res) => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            for (const one of Array.isArray(value) ? value : [value ?? ""]) {
              headers.append(key, one);
            }
          }
          const status = res.statusCode ?? 502;
          // 204/304 must not carry a body, and Response rejects one.
          const body = status === 204 || status === 304 ? null : Readable.toWeb(res);
          resolve(new Response(body as ConstructorParameters<typeof Response>[0], { status, headers }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }) as unknown as typeof fetch;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Open a CONNECT tunnel through the proxy, then TLS over it when asked. */
function tunnel(
  socketPath: string,
  hostname: string,
  port: number,
  secure: boolean,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const target = `${hostname}:${port}`;
    const proxy = netConnect({ path: socketPath });
    const fail = (err: Error): void => {
      proxy.destroy();
      reject(err);
    };
    proxy.on("error", fail);
    proxy.on("connect", () => {
      proxy.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });

    let banner = "";
    const onData = (chunk: Buffer): void => {
      banner += chunk.toString("latin1");
      const end = banner.indexOf("\r\n\r\n");
      if (end === -1) {
        if (banner.length > BANNER_LIMIT) {
          fail(new Error("egress proxy sent an oversized CONNECT response"));
        }
        return;
      }
      proxy.removeListener("data", onData);
      const statusLine = banner.slice(0, banner.indexOf("\r\n"));
      if (Number(statusLine.split(" ")[1]) !== 200) {
        fail(new Error(`egress proxy refused CONNECT: ${statusLine}`));
        return;
      }
      // Anything past the blank line already belongs to the tunnel.
      const extra = Buffer.from(banner.slice(end + 4), "latin1");
      if (extra.length > 0) {
        proxy.unshift(extra);
      }
      if (!secure) {
        proxy.removeListener("error", fail);
        resolve(proxy);
        return;
      }
      const tls = tlsConnect({ socket: proxy, servername: hostname }, () => {
        proxy.removeListener("error", fail);
        resolve(tls);
      });
      tls.on("error", fail);
    };
    proxy.on("data", onData);
  });
}
