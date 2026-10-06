import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent as HttpAgent } from "node:http";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import type WebSocket from "discord-ws";
import { WebSocketServer } from "discord-ws";

import { BRIDGE_INTENTS, GatewayConnection, type GatewaySession, type SessionStore } from "./gateway.js";

/** A name that cannot resolve: reaching the stand-in proves the tunnel. */
const HOST = "discord-stand-in.invalid";

interface Proxy {
  socketPath: string;
  connects: string[];
}

/** netd's egress contract, minus the policy: CONNECT, then move bytes. */
async function proxy(t: { after(fn: () => void): void }, targetPort: number): Promise<Proxy> {
  const socketPath = `/tmp/thicket-dg-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;
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
  /** Every frame the client sent, parsed. */
  received: { op: number; d?: unknown }[];
  send(frame: unknown): void;
  close(code: number, reason?: string): void;
  drop(): void;
  /** Whether the stand-in answers heartbeats. */
  ack: boolean;
  heartbeatInterval: number;
  connections: number;
}

/** Enough of the Gateway to hold a session: hello, identify or resume, heartbeats. */
async function standIn(t: { after(fn: () => void): void }): Promise<StandIn> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const state: StandIn = {
    port: 0,
    received: [],
    send: () => {},
    close: () => {},
    drop: () => {},
    ack: true,
    heartbeatInterval: 60_000,
    connections: 0,
  };
  wss.on("connection", (socket: WebSocket) => {
    state.connections += 1;
    state.send = (frame) => socket.send(JSON.stringify(frame));
    state.close = (code, reason) => socket.close(code, reason);
    state.drop = () => socket.terminate();
    socket.on("message", (data: unknown) => {
      const frame = JSON.parse(String(data)) as { op: number; d?: unknown };
      state.received.push(frame);
      if (frame.op === 2) {
        socket.send(
          JSON.stringify({
            op: 0,
            s: 1,
            t: "READY",
            d: {
              session_id: "sess-1",
              resume_gateway_url: `ws://${HOST}:${state.port}/resume`,
              user: { id: "bot-1", username: "thicket-dev" },
            },
          }),
        );
      }
      if (frame.op === 6) {
        socket.send(JSON.stringify({ op: 0, s: 7, t: "RESUMED", d: {} }));
      }
      if (frame.op === 1 && state.ack) {
        socket.send(JSON.stringify({ op: 11 }));
      }
    });
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: state.heartbeatInterval } }));
  });
  await once(wss, "listening");
  const address = wss.address();
  state.port = typeof address === "object" && address !== null ? address.port : 0;
  t.after(() => wss.close());
  return state;
}

class MemoryStore implements SessionStore {
  session: GatewaySession | undefined;
  load() {
    return this.session;
  }
  save(session: GatewaySession) {
    this.session = session;
  }
  clear() {
    this.session = undefined;
  }
}

function gatewayBotFetch(port: number, seen: { auth?: string }): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    seen.auth = String(new Headers(init?.headers).get("authorization"));
    return new Response(
      JSON.stringify({ url: `ws://${HOST}:${port}`, session_start_limit: { remaining: 999, total: 1000 } }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ignoreDispatch = async () => {};

test("identifies through the egress socket and records the session", async (t) => {
  const discord = await standIn(t);
  const p = await proxy(t, discord.port);
  const seen: { auth?: string } = {};
  const sessions = new MemoryStore();
  const gateway = new GatewayConnection({
    token: "bot-token",
    fetchImpl: gatewayBotFetch(discord.port, seen),
    agent: tunnellingAgent(p.socketPath) as never,
    sessions,
    onDispatch: ignoreDispatch,
  });
  t.after(() => gateway.stop());

  await gateway.start();

  assert.equal(seen.auth, "Bot bot-token");
  assert.deepEqual(p.connects, [`${HOST}:${discord.port}`], "the socket must go through the tunnel");
  const identify = discord.received.find((f) => f.op === 2)?.d as { token: string; intents: number };
  assert.equal(identify.token, "bot-token");
  assert.equal(identify.intents, BRIDGE_INTENTS);
  assert.equal(gateway.selfId, "bot-1");
  assert.deepEqual(sessions.session, {
    sessionId: "sess-1",
    resumeUrl: `ws://${HOST}:${discord.port}/resume`,
    seq: 1,
    userId: "bot-1",
  });
});

test("a stored session resumes on the resume host and keeps the sequence", async (t) => {
  const discord = await standIn(t);
  const p = await proxy(t, discord.port);
  const sessions = new MemoryStore();
  sessions.session = { sessionId: "sess-old", resumeUrl: `ws://${HOST}:${discord.port}/resume`, seq: 41, userId: "bot-1" };
  const gateway = new GatewayConnection({
    token: "bot-token",
    fetchImpl: (() => {
      throw new Error("a resume must not ask for a gateway URL");
    }) as never,
    agent: tunnellingAgent(p.socketPath) as never,
    sessions,
    onDispatch: ignoreDispatch,
  });
  t.after(() => gateway.stop());
  const resumed = once(gateway, "resumed");

  await gateway.start();
  await resumed;

  const resume = discord.received.find((f) => f.op === 6)?.d as { session_id: string; seq: number };
  assert.deepEqual(resume, { token: "bot-token", session_id: "sess-old", seq: 41 });
  assert.equal(sessions.session?.seq, 7, "the RESUMED frame's sequence is recorded");
  assert.equal(gateway.selfId, "bot-1", "a resume replays no READY, so the id comes from the session");
});

test("a dispatch's sequence is recorded only after its handler has finished", async (t) => {
  const discord = await standIn(t);
  const p = await proxy(t, discord.port);
  const sessions = new MemoryStore();
  const dispatches: [string, unknown][] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gateway = new GatewayConnection({
    token: "bot-token",
    fetchImpl: gatewayBotFetch(discord.port, {}),
    agent: tunnellingAgent(p.socketPath) as never,
    sessions,
    onDispatch: async (type, data) => {
      dispatches.push([type, data]);
      await held;
    },
  });
  t.after(() => gateway.stop());
  await gateway.start();

  discord.send({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "m1" } });
  await wait(50);
  assert.deepEqual(dispatches, [["MESSAGE_CREATE", { id: "m1" }]]);
  assert.equal(sessions.session?.seq, 1, "not yet: the handler is still running");

  release();
  await wait(20);
  assert.equal(sessions.session?.seq, 2, "recorded once the handler returned");
});

test("heartbeats on the interval, and a missed ack closes the socket with the session kept", async (t) => {
  const discord = await standIn(t);
  discord.heartbeatInterval = 40;
  const p = await proxy(t, discord.port);
  const sessions = new MemoryStore();
  const gateway = new GatewayConnection({
    token: "bot-token",
    fetchImpl: gatewayBotFetch(discord.port, {}),
    agent: tunnellingAgent(p.socketPath) as never,
    sessions,
    onDispatch: ignoreDispatch,
  });
  t.after(() => gateway.stop());
  const closed = once(gateway, "close");
  await gateway.start();

  await wait(120);
  assert.ok(discord.received.some((f) => f.op === 1), "a heartbeat was sent");
  discord.ack = false;
  const [info] = (await closed) as [{ code: number; fatal: boolean }];

  assert.equal(info.fatal, false);
  assert.equal(info.code, 1006, "terminated without a close frame");
  assert.ok(sessions.session !== undefined, "the session survives a zombie close, to be resumed");
});

test("4009 ends the session; 4004 is fatal; a server 4000 keeps it", async (t) => {
  for (const [code, expectSession, expectFatal] of [
    [4009, false, false],
    [4004, true, true],
    [4000, true, false],
  ] as const) {
    const discord = await standIn(t);
    const p = await proxy(t, discord.port);
    const sessions = new MemoryStore();
    const gateway = new GatewayConnection({
      token: "bot-token",
      fetchImpl: gatewayBotFetch(discord.port, {}),
      agent: tunnellingAgent(p.socketPath) as never,
      sessions,
      onDispatch: ignoreDispatch,
    });
    const closed = once(gateway, "close");
    await gateway.start();
    discord.close(code, "test");
    const [info] = (await closed) as [{ code: number; fatal: boolean }];
    assert.equal(info.code, code);
    assert.equal(info.fatal, expectFatal, `${code} fatal`);
    assert.equal(sessions.session !== undefined, expectSession, `${code} keeps the session`);
  }
});

test("an invalid session with d:false clears the store; a reconnect request keeps it", async (t) => {
  const discord = await standIn(t);
  const p = await proxy(t, discord.port);
  const sessions = new MemoryStore();
  const gateway = new GatewayConnection({
    token: "bot-token",
    fetchImpl: gatewayBotFetch(discord.port, {}),
    agent: tunnellingAgent(p.socketPath) as never,
    sessions,
    onDispatch: ignoreDispatch,
  });
  const closed = once(gateway, "close");
  await gateway.start();
  discord.send({ op: 9, d: false });
  await closed;
  assert.equal(sessions.session, undefined);

  const discord2 = await standIn(t);
  const p2 = await proxy(t, discord2.port);
  const sessions2 = new MemoryStore();
  const gateway2 = new GatewayConnection({
    token: "bot-token",
    fetchImpl: gatewayBotFetch(discord2.port, {}),
    agent: tunnellingAgent(p2.socketPath) as never,
    sessions: sessions2,
    onDispatch: ignoreDispatch,
  });
  const closed2 = once(gateway2, "close");
  await gateway2.start();
  discord2.send({ op: 7 });
  const [info] = (await closed2) as [{ code: number }];
  assert.equal(info.code, 4000, "closed by us with a code that keeps the session");
  assert.ok(sessions2.session !== undefined);
});
