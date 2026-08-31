import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent as HttpAgent } from "node:http";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import { WebSocketServer } from "slack-ws";

import { SocketModeConnection } from "./socket-mode.js";

/** A name that cannot resolve: reaching the stand-in proves the tunnel. */
const HOST = "slack-stand-in.invalid";

interface Proxy {
  socketPath: string;
  connects: string[];
}

/** netd's egress contract, minus the policy: CONNECT, then move bytes. */
async function proxy(t: { after(fn: () => void): void }, targetPort: number): Promise<Proxy> {
  const socketPath = `/tmp/thicket-sm-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;
  const connects: string[] = [];
  const server: Server = createServer((client) => {
    client.once("data", (chunk: Buffer) => {
      const [line] = chunk.toString("latin1").split("\r\n");
      const [method, target] = (line ?? "").split(" ");
      if (method !== "CONNECT" || target === undefined) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        return;
      }
      connects.push(target);
      const upstream = netConnect({ host: "127.0.0.1", port: targetPort }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
    });
    client.on("error", () => {});
  });
  server.listen(socketPath);
  await once(server, "listening");
  t.after(() => server.close());
  return { socketPath, connects };
}

/** An agent whose every connection is a CONNECT tunnel through the socket. */
function tunnellingAgent(socketPath: string): HttpAgent {
  const agent = new HttpAgent({ keepAlive: false });
  agent.createConnection = ((
    options: { host?: string; port?: number },
    callback: (err: Error | null, socket?: Duplex) => void,
  ): undefined => {
    const target = `${options.host ?? HOST}:${options.port ?? 443}`;
    const proxied: Socket = netConnect({ path: socketPath });
    proxied.on("connect", () => proxied.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    proxied.once("data", (chunk: Buffer) => {
      if (!chunk.toString("latin1").startsWith("HTTP/1.1 200")) {
        callback(new Error("proxy refused CONNECT"));
        return;
      }
      callback(null, proxied);
    });
    proxied.on("error", (err) => callback(err));
    return undefined;
  }) as HttpAgent["createConnection"];
  return agent;
}

interface StandIn {
  port: number;
  acks: string[];
  send(frame: unknown): void;
  drop(): void;
}

/** Enough of Socket Mode to hold a session: hello, an envelope, an ack. */
async function standIn(t: { after(fn: () => void): void }): Promise<StandIn> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const state: StandIn = {
    port: 0,
    acks: [],
    send: () => {},
    drop: () => {},
  };
  wss.on("connection", (socket) => {
    state.send = (frame) => socket.send(JSON.stringify(frame));
    state.drop = () => socket.terminate();
    socket.on("message", (data: unknown) => state.acks.push(String(data)));
    socket.send(JSON.stringify({ type: "hello", num_connections: 1 }));
  });
  await once(wss, "listening");
  const address = wss.address();
  state.port = typeof address === "object" && address !== null ? address.port : 0;
  t.after(() => wss.close());
  return state;
}

function openConnectionFetch(port: number, seen: { url?: string; auth?: string }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.url = String(input);
    seen.auth = String(new Headers(init?.headers).get("authorization"));
    return new Response(JSON.stringify({ ok: true, url: `ws://${HOST}:${port}/link` }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

test("a session runs entirely through the egress socket, ack included", async (t) => {
  const slack = await standIn(t);
  const p = await proxy(t, slack.port);
  const seen: { url?: string; auth?: string } = {};

  const client = new SocketModeConnection({
    appToken: "xapp-stand-in",
    fetchImpl: openConnectionFetch(slack.port, seen),
    agent: tunnellingAgent(p.socketPath) as never,
  });
  t.after(() => void client.disconnect());

  const connected = once(client, "connected");
  await client.start();
  await connected;

  assert.equal(seen.url, "https://slack.com/api/apps.connections.open");
  assert.equal(seen.auth, "Bearer xapp-stand-in");
  assert.deepEqual(
    p.connects,
    [`${HOST}:${slack.port}`],
    "the socket must reach Slack by asking netd, never by dialing",
  );

  const delivered = once(client, "slack_event") as Promise<
    [{ ack(): Promise<void>; type?: string; event?: unknown; retry_num?: number }]
  >;
  slack.send({
    envelope_id: "env-1",
    type: "events_api",
    retry_attempt: 2,
    payload: { event: { type: "app_mention", text: "through the tunnel" } },
  });
  const [args] = await delivered;
  assert.equal(args.type, "events_api");
  assert.deepEqual(args.event, { type: "app_mention", text: "through the tunnel" });
  assert.equal(args.retry_num, 2);

  await args.ack();
  // The ack goes back down the same socket, so it is the round trip proved.
  for (let i = 0; i < 50 && slack.acks.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(JSON.parse(slack.acks[0] ?? "{}"), { envelope_id: "env-1" });
});

test("a socket that stops delivering is reported up rather than looking healthy", async (t) => {
  const slack = await standIn(t);
  const p = await proxy(t, slack.port);

  const client = new SocketModeConnection({
    appToken: "xapp-stand-in",
    fetchImpl: openConnectionFetch(slack.port, {}),
    agent: tunnellingAgent(p.socketPath) as never,
    silenceTimeoutMs: 120,
  });
  t.after(() => void client.disconnect());

  await client.start();
  const [reason] = (await once(client, "close")) as [string];
  assert.match(reason, /nothing received for 120ms/);
});

test("slack asking us to disconnect ends the connection rather than being ignored", async (t) => {
  const slack = await standIn(t);
  const p = await proxy(t, slack.port);

  const client = new SocketModeConnection({
    appToken: "xapp-stand-in",
    fetchImpl: openConnectionFetch(slack.port, {}),
    agent: tunnellingAgent(p.socketPath) as never,
  });
  t.after(() => void client.disconnect());

  await client.start();
  const closed = once(client, "close") as Promise<[string]>;
  slack.send({ type: "disconnect", reason: "refresh_requested" });
  const [reason] = await closed;
  assert.match(reason, /slack sent disconnect/);
});

test("apps.connections.open failing says what slack said", async (t) => {
  const slack = await standIn(t);
  const p = await proxy(t, slack.port);
  const client = new SocketModeConnection({
    appToken: "xapp-bad",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    agent: tunnellingAgent(p.socketPath) as never,
  });
  await assert.rejects(() => client.start(), /invalid_auth/);
  assert.deepEqual(p.connects, [], "no socket should be opened when there is no URL");
});
