/**
 * The way out of an account that has no network of its own: netd runs a
 * forward proxy on a unix socket, admits only the destinations its
 * `egress_allow` names, and dials tailnet names through the tailnet so they
 * carry this account's tag. What a process reaches is therefore what was
 * rendered into its config, which is what lets a URL arriving in an inbound
 * message be fetched at all.
 *
 * Every request goes through a CONNECT tunnel, https included, so TLS is
 * terminated by the peer rather than by the proxy: netd moves bytes it
 * cannot read.
 *
 * Two shapes of the same thing. `egressFetch` is for our own code, which
 * takes a `fetch`; `egressAgent` is for libraries that take a Node agent
 * instead — `@slack/web-api`, and anything else with a client we did not
 * write.
 */

import { statSync } from "node:fs";
import { Agent as HttpAgent, request as httpRequest, type ClientRequestArgs } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { Readable, type Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";

const BANNER_LIMIT = 8192;

/** A fetch that leaves through the egress socket. */
export function egressFetch(socketPath: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const port = url.port === "" ? (url.protocol === "http:" ? 80 : 443) : Number(url.port);
    const socket = await tunnel(socketPath, url.hostname, port, url.protocol === "https:");
    return await new Promise<Response>((resolve, reject) => {
      // The tunnel is already open and single-use, so the request must be
      // handed the socket rather than allowed to dial for itself.
      const agent = new HttpAgent({ keepAlive: false });
      agent.createConnection = () => socket;
      const req = httpRequest(
        {
          agent,
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
      const body = init?.body;
      if (body === undefined || body === null) {
        req.end();
      } else if (typeof body === "string" || body instanceof Uint8Array) {
        req.end(body);
      } else {
        req.destroy();
        reject(new Error("egressFetch supports only string or byte bodies"));
      }
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
export function tunnel(
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

/**
 * An https.Agent whose every connection is a CONNECT tunnel through the
 * egress socket. Pass it to a library that dials for itself; the TLS the
 * agent would normally do is done inside the tunnel instead, so the far end
 * still terminates it.
 *
 * Connections are pooled — Node keys them by destination, so no two
 * destinations share a tunnel — because a bridge streaming a reply makes
 * many calls to one host and a fresh CONNECT and handshake for each is
 * latency nobody asked for.
 */
export function egressAgent(socketPath: string): HttpsAgent {
  return new EgressAgent(socketPath);
}

class EgressAgent extends HttpsAgent {
  constructor(private readonly socketPath: string) {
    super({ keepAlive: true });
  }

  override createConnection(
    options: ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): undefined {
    const host = options.host ?? "";
    const port = Number(options.port ?? 443);
    tunnel(this.socketPath, host, port, true).then(
      (socket) => callback?.(null, socket),
      // Node's own callback ignores the stream once the error is set, and
      // a tunnel that never opened has none to hand over.
      (err: Error) => callback?.(err, undefined as unknown as Duplex),
    );
    return undefined;
  }
}

/**
 * Fail at startup rather than at the first outbound call. A process meant
 * to have no network of its own must never quietly find another way out, so
 * an absent socket is fatal and says which path it looked at — the ordinary
 * cause is netd not started, or started as another user.
 */
export function assertEgressSocket(socketPath: string): void {
  let stats;
  try {
    stats = statSync(socketPath);
  } catch {
    throw new Error(
      `no egress socket at ${socketPath}: netd owns it, so start netd first — ` +
        `there is no direct-dial fallback, by design`,
    );
  }
  if (!stats.isSocket()) {
    throw new Error(`egress path ${socketPath} is not a socket`);
  }
}
