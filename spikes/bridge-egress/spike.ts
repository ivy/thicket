/**
 * Can the bridge's outbound legs be tunnelled through netd's egress socket,
 * under Bun?
 *
 * The A2A leg already can — `RemoteAgentClient` takes a `fetchImpl`, and
 * agentd's `egressFetch` proves CONNECT-over-unix works under Bun. The open
 * question is Slack's two legs, which are not ours: `@slack/web-api` and the
 * WebSocket inside `@slack/socket-mode`. Both are steered by one knob, a
 * `clientOptions.agent` that socket-mode reuses for its WebSocket.
 *
 * The stand-in answers on `slack-stand-in.invalid`, a name that cannot
 * resolve. So a leg that reaches it went through the tunnel, and a leg that
 * fails to resolve went around it — no counting required to tell them apart,
 * though the proxy counts CONNECTs anyway.
 *
 *   mise exec -- bun run spikes/bridge-egress/spike.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { Agent as HttpsAgent, createServer as createHttpsServer } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";

import BunWebSocket from "ws";

const HOST = "slack-stand-in.invalid";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The installed package's own entry point. Spikes live outside the pnpm
 * workspace, so nothing here resolves by name — and for `ws` that is the
 * point: this is what the bare specifier is being compared against.
 */
function pnpmEntry(pkg: string): string {
  const pnpm = join(REPO_ROOT, "node_modules", ".pnpm");
  const flat = pkg.replace("/", "+");
  const dir = readdirSync(pnpm).find((name) => name.startsWith(`${flat}@`));
  if (dir === undefined) {
    throw new Error(`${pkg} is not installed under node_modules/.pnpm`);
  }
  const root = join(pnpm, dir, "node_modules", pkg);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { main?: string };
  return join(root, manifest.main ?? "index.js");
}

const realWsEntry = (): string => pnpmEntry("ws");

interface CertPair {
  cert: Buffer;
  key: Buffer;
  dir: string;
}

/** A self-signed cert for the stand-in's name; the agent trusts only this. */
function selfSignedCert(): CertPair {
  const dir = mkdtempSync(join(tmpdir(), "spike-cert-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(dir, "key.pem"),
    "-out", join(dir, "cert.pem"),
    "-days", "1",
    "-subj", `/CN=${HOST}`,
    "-addext", `subjectAltName=DNS:${HOST}`,
  ], { stdio: "ignore" });
  return { cert: readFileSync(join(dir, "cert.pem")), key: readFileSync(join(dir, "key.pem")), dir };
}

/** CONNECT tunnel over the unix socket, then TLS to the far end. */
function tunnel(socketPath: string, host: string, port: number, ca: Buffer): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const target = `${host}:${port}`;
    const proxy = netConnect({ path: socketPath });
    const fail = (err: Error): void => {
      proxy.destroy();
      reject(err);
    };
    proxy.on("error", fail);
    proxy.on("connect", () => proxy.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let banner = "";
    const onData = (chunk: Buffer): void => {
      banner += chunk.toString("latin1");
      const end = banner.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      proxy.removeListener("data", onData);
      const statusLine = banner.slice(0, banner.indexOf("\r\n"));
      if (Number(statusLine.split(" ")[1]) !== 200) {
        fail(new Error(`proxy refused CONNECT: ${statusLine}`));
        return;
      }
      const extra = Buffer.from(banner.slice(end + 4), "latin1");
      if (extra.length > 0) {
        proxy.unshift(extra);
      }
      const secure = tlsConnect({ socket: proxy, servername: host, ca }, () => {
        proxy.removeListener("error", fail);
        resolve(secure);
      });
      secure.on("error", fail);
    };
    proxy.on("data", onData);
  });
}

/** An https.Agent whose connections are CONNECT tunnels through the socket. */
class EgressAgent extends HttpsAgent {
  constructor(
    private readonly socketPath: string,
    private readonly ca: Buffer,
  ) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: { host?: string; port?: number },
    callback: (err: Error | null, socket?: Socket) => void,
  ): undefined {
    tunnel(this.socketPath, options.host ?? HOST, options.port ?? 443, this.ca).then(
      (socket) => callback(null, socket),
      (err: Error) => callback(err),
    );
    return undefined;
  }
}

interface Proxy {
  socketPath: string;
  connects: () => string[];
  close: () => void;
}

/** netd's egress contract, minus the policy: CONNECT to the stand-in only. */
function startProxy(targetPort: number): Promise<Proxy> {
  const socketPath = join(mkdtempSync(join(tmpdir(), "spike-egress-")), "netd-egress.sock");
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }
  const connects: string[] = [];
  const server = createHttpServer((_req, res) => {
    res.writeHead(400).end("CONNECT only\n");
  });
  server.on("connect", (req, client) => {
    connects.push(String(req.url));
    const [host] = String(req.url).split(":");
    if (host !== HOST) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = netConnect({ host: "127.0.0.1", port: targetPort }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    client.on("error", () => upstream.destroy());
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        connects: () => [...connects],
        close: () => server.close(),
      });
    });
  });
}

interface StandIn {
  port: number;
  acks: () => string[];
  close: () => void;
}

/** Enough of Slack to answer both legs: the Web API call, then the socket. */
async function startStandIn(cert: CertPair): Promise<StandIn> {
  const { WebSocketServer } = (await import(realWsEntry())) as {
    WebSocketServer: new (opts: object) => {
      on(event: "connection", cb: (socket: {
        send(data: string): void;
        on(event: "message", cb: (data: unknown) => void): void;
      }) => void): void;
      close(): void;
    };
  };
  const acks: string[] = [];
  const server = createHttpsServer({ cert: cert.cert, key: cert.key }, (req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (String(req.url).includes("apps.connections.open")) {
        res.end(JSON.stringify({ ok: true, url: `wss://${HOST}/link` }));
        return;
      }
      res.end(JSON.stringify({ ok: true, url: `https://${HOST}/`, team: "T1", user: "U1", bot_id: "B1" }));
    });
  });
  const wss = new WebSocketServer({ server, path: "/link" });
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "hello", num_connections: 1 }));
    socket.send(
      JSON.stringify({
        envelope_id: "env-1",
        type: "events_api",
        accepts_response_payload: false,
        payload: {
          event: { type: "app_mention", text: "through the tunnel", channel: "C1", ts: "1.0", user: "U1" },
        },
      }),
    );
    socket.on("message", (data: unknown) => acks.push(String(data)));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        acks: () => [...acks],
        close: () => {
          wss.close();
          server.close();
        },
      });
    });
  });
}

interface Result {
  scenario: string;
  tunnelled: boolean;
  connects: number;
  detail: string;
}

const results: Result[] = [];

function record(scenario: string, tunnelled: boolean, connects: number, detail: string): void {
  results.push({ scenario, tunnelled, connects, detail });
  const mark = tunnelled ? "tunnelled" : "BYPASSED ";
  process.stdout.write(`  ${mark}  ${scenario} — ${detail} (${connects} CONNECT)\n`);
}

function timeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);
}

/** One websocket connect, whichever implementation is handed in. */
function tryWebSocket(
  Impl: new (url: string, opts: object) => {
    on(event: string, cb: (arg: unknown) => void): void;
    close(): void;
  },
  agent: EgressAgent,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new Impl(`wss://${HOST}/link`, { agent });
    socket.on("message", (data: unknown) => {
      socket.close();
      resolve(`first frame: ${String(data).slice(0, 40)}`);
    });
    // Bun's built-in ws emits an ErrorEvent, the real package an Error.
    socket.on("error", (err: unknown) => {
      const message = (err as { message?: unknown }).message;
      reject(new Error(typeof message === "string" ? message : String(err)));
    });
  });
}

async function main(): Promise<void> {
  const cert = selfSignedCert();
  const standIn = await startStandIn(cert);
  const proxy = await startProxy(standIn.port);
  const agent = new EgressAgent(proxy.socketPath, cert.cert);
  process.stdout.write(`stand-in on 127.0.0.1:${standIn.port} as ${HOST}; egress socket ${proxy.socketPath}\n\n`);

  let before = 0;
  const since = (): number => {
    const now = proxy.connects().length;
    const delta = now - before;
    before = now;
    return delta;
  };

  // 1. The bare "ws" specifier — what @slack/socket-mode itself writes.
  try {
    const detail = await timeout(tryWebSocket(BunWebSocket as never, agent), 10_000, "bare ws");
    record('raw websocket, bare "ws" specifier', true, since(), detail);
  } catch (err) {
    record('raw websocket, bare "ws" specifier', false, since(), (err as Error).message);
  }

  // 2. The same, resolved to the installed package rather than the specifier.
  const { default: RealWebSocket } = (await import(realWsEntry())) as {
    default: new (url: string, opts: object) => never;
  };
  try {
    const detail = await timeout(tryWebSocket(RealWebSocket as never, agent), 10_000, "real ws");
    record("raw websocket, installed ws package", true, since(), detail);
  } catch (err) {
    record("raw websocket, installed ws package", false, since(), (err as Error).message);
  }

  const { WebClient } = (await import(pnpmEntry("@slack/web-api"))) as {
    WebClient: new (token: string, opts: object) => { auth: { test(): Promise<{ ok?: boolean }> } };
  };
  const { SocketModeClient } = (await import(pnpmEntry("@slack/socket-mode"))) as {
    SocketModeClient: new (opts: object) => {
      on(event: string, cb: (args: { ack?: () => Promise<void>; body?: { event?: { text?: string } } }) => void): void;
      start(): Promise<unknown>;
      disconnect(): Promise<void>;
    };
  };

  // 3. The Web API leg.
  try {
    const web = new WebClient("xoxb-stand-in", { agent, slackApiUrl: `https://${HOST}/api/` });
    const res = await timeout(web.auth.test(), 10_000, "auth.test");
    record("@slack/web-api WebClient", true, since(), `auth.test ok=${String(res.ok)}`);
  } catch (err) {
    record("@slack/web-api WebClient", false, since(), (err as Error).message);
  }

  // 4. The whole Socket Mode client: the Web API call for the wss URL, then
  //    the socket it opens from the answer.
  const client = new SocketModeClient({
    appToken: "xapp-stand-in",
    clientOptions: { agent, slackApiUrl: `https://${HOST}/api/` },
  });
  try {
    const event = new Promise<string>((resolve) => {
      client.on("slack_event", (args) => {
        void args.ack?.();
        resolve(String(args.body?.event?.text));
      });
    });
    await timeout(client.start(), 15_000, "socket mode start");
    const text = await timeout(event, 15_000, "socket mode event");
    record("@slack/socket-mode SocketModeClient", true, since(), `event delivered: ${text}`);
  } catch (err) {
    record("@slack/socket-mode SocketModeClient", false, since(), (err as Error).message);
  }
  await client.disconnect().catch(() => {});

  process.stdout.write(`\nCONNECTs the proxy saw: ${JSON.stringify(proxy.connects())}\n`);
  process.stdout.write(`acks the stand-in received: ${standIn.acks().length}\n`);
  const bypassed = results.filter((r) => !r.tunnelled).map((r) => r.scenario);
  process.stdout.write(
    bypassed.length === 0
      ? "\nEvery leg tunnelled.\n"
      : `\nBypassed netd: ${bypassed.join("; ")}\n`,
  );

  proxy.close();
  standIn.close();
  rmSync(cert.dir, { recursive: true, force: true });
  process.exit(0);
}

await main();
