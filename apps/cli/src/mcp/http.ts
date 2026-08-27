import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface HttpRequestSpec {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** Minimal HTTP door; production routes through netd's egress proxy. */
export type HttpDoer = (spec: HttpRequestSpec) => Promise<HttpResponse>;

const DEFAULT_TIMEOUT_MS = 10_000;

function collect(
  resolve: (r: HttpResponse) => void,
  reject: (e: Error) => void,
  timeoutMs: number,
  makeRequest: (onResponse: (res: import("node:http").IncomingMessage) => void) => import("node:http").ClientRequest,
): void {
  const req = makeRequest((res) => {
    let body = "";
    res.on("data", (chunk: Buffer) => (body += chunk.toString()));
    res.on("end", () =>
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
    );
  });
  req.setTimeout(timeoutMs, () => {
    req.destroy(new Error(`timed out after ${timeoutMs}ms`));
  });
  req.on("error", reject);
  req.end();
}

/**
 * HttpDoer through netd's egress unix socket, so outbound calls carry the
 * caller's tailnet identity instead of the host's. http URLs go
 * absolute-form through the proxy; https URLs get a CONNECT tunnel and
 * TLS inside it.
 */
export function egressHttp(socketPath: string): HttpDoer {
  return (spec) =>
    new Promise((resolve, reject) => {
      const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const url = new URL(spec.url);
      if (url.protocol === "http:") {
        collect(resolve, reject, timeoutMs, (onResponse) => {
          const req = httpRequest(
            {
              socketPath,
              path: spec.url, // absolute-form: the proxy dials the target
              method: spec.method,
              headers: { host: url.host, ...spec.headers },
            },
            onResponse,
          );
          if (spec.body !== undefined) {
            req.write(spec.body);
          }
          return req;
        });
        return;
      }

      // https: CONNECT through the proxy, then TLS inside the tunnel.
      const port = url.port === "" ? "443" : url.port;
      const proxied = netConnect(socketPath);
      proxied.setTimeout(timeoutMs, () => {
        proxied.destroy();
        reject(new Error(`timed out after ${timeoutMs}ms establishing tunnel`));
      });
      proxied.on("error", reject);
      proxied.write(`CONNECT ${url.hostname}:${port} HTTP/1.1\r\nHost: ${url.hostname}:${port}\r\n\r\n`);
      let banner = "";
      const onData = (chunk: Buffer) => {
        banner += chunk.toString();
        if (!banner.includes("\r\n\r\n")) {
          return;
        }
        proxied.off("data", onData);
        if (!/^HTTP\/1\.[01] 200/.test(banner)) {
          proxied.destroy();
          reject(new Error(`egress proxy refused CONNECT: ${banner.split("\r\n")[0]}`));
          return;
        }
        collect(resolve, reject, timeoutMs, (onResponse) => {
          const req = httpsRequest(
            {
              method: spec.method,
              host: url.hostname,
              path: url.pathname + url.search,
              headers: { host: url.host, ...spec.headers },
              createConnection: () =>
                tlsConnect({ socket: proxied, servername: url.hostname }),
            },
            onResponse,
          );
          if (spec.body !== undefined) {
            req.write(spec.body);
          }
          return req;
        });
      };
      proxied.on("data", onData);
    });
}
