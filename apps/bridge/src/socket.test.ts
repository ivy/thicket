import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import type { EngineLogger } from "./engine.js";
import { SlackSocketConnection, type SocketishClient } from "./socket.js";
import type { InboundEvent } from "./types.js";

class FakeClient extends EventEmitter implements SocketishClient {
  disconnects = 0;
  startBehaviour: "connect" | "hang" | "reject" = "connect";

  async start(): Promise<void> {
    if (this.startBehaviour === "hang") {
      return new Promise(() => {});
    }
    if (this.startBehaviour === "reject") {
      throw new Error("apps.connections.open refused");
    }
    this.emit("connected");
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1;
  }
}

interface LoggedLine {
  level: "info" | "warn";
  msg: string;
  fields?: Record<string, unknown>;
}

function collector(): { logger: EngineLogger; lines: LoggedLine[] } {
  const lines: LoggedLine[] = [];
  return {
    lines,
    logger: {
      info: (msg, fields) => lines.push({ level: "info", msg, ...(fields ? { fields } : {}) }),
      warn: (msg, fields) => lines.push({ level: "warn", msg, ...(fields ? { fields } : {}) }),
    },
  };
}

function connect(options: {
  client: FakeClient;
  logger?: EngineLogger;
  deadlineMs?: number;
  onEvent?: (event: InboundEvent) => void;
}): SlackSocketConnection {
  return new SlackSocketConnection(
    "xapp-fake",
    options.onEvent ?? (() => {}),
    options.logger,
    { client: options.client, recoveryDeadlineMs: options.deadlineMs ?? 25 },
  );
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a socket that closes and never recovers is abandoned before the terminal disconnected", async () => {
  const client = new FakeClient();
  const { logger, lines } = collector();
  const connection = connect({ client, logger });
  const reasons: string[] = [];
  connection.onDown((reason) => reasons.push(reason));
  await connection.start();

  client.emit("close"); // library noticed the dead socket; recovery never comes
  await settle(60);

  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /did not recover within 25ms after close/);
  assert.ok(client.disconnects >= 1, "the stuck client is disconnected, not leaked");
  assert.ok(
    lines.some((l) => l.level === "warn" && l.msg === "abandoning socket mode connection"),
    "the abandonment is logged with its reason",
  );
});

test("a socket that recovers within the deadline is not reported down", async () => {
  const client = new FakeClient();
  const connection = connect({ client });
  const reasons: string[] = [];
  connection.onDown((reason) => reasons.push(reason));
  await connection.start();

  client.emit("close");
  client.emit("reconnecting");
  client.emit("connected"); // recovery beat the deadline
  await settle(60);

  assert.equal(reasons.length, 0, "no spurious down for a healthy reconnect");
  assert.equal(client.disconnects, 0);
});

test("each disruption gets its own deadline; recovery re-arms the watchdog", async () => {
  const client = new FakeClient();
  const connection = connect({ client });
  const reasons: string[] = [];
  connection.onDown((reason) => reasons.push(reason));
  await connection.start();

  client.emit("close");
  client.emit("connected");
  await settle(60);
  assert.equal(reasons.length, 0);

  client.emit("close"); // second disruption, this one never recovers
  await settle(60);
  assert.equal(reasons.length, 1);
});

test("the library's terminal disconnected still reaches the supervisor, exactly once", async () => {
  const client = new FakeClient();
  const connection = connect({ client });
  const reasons: string[] = [];
  connection.onDown((reason) => reasons.push(reason));
  await connection.start();

  client.emit("close");
  client.emit("disconnected"); // library gave up before our deadline
  await settle(60);

  assert.equal(reasons.length, 1, "watchdog deadline must not double-fire after the terminal event");
  assert.match(reasons[0]!, /gave up reconnecting/);
});

test("a hanging initial connect times out, kills the client, and stays silent afterwards", async () => {
  const client = new FakeClient();
  client.startBehaviour = "hang";
  const connection = connect({ client });
  const reasons: string[] = [];
  connection.onDown((reason) => reasons.push(reason));

  await assert.rejects(() => connection.start(), /did not connect within 25ms/);
  assert.equal(client.disconnects, 1);

  // The abandoned client's death throes must not fire onDown: the
  // supervisor already rescheduled when start() threw, and a late down
  // would spawn a second connection for the same agent.
  client.emit("disconnected");
  await settle(10);
  assert.equal(reasons.length, 0);
});

test("stopping the connection does not report it down", async () => {
  const client = new FakeClient();
  const connection = connect({ client });
  const reasons: string[] = [];
  connection.onDown((reason) => reasons.push(reason));
  await connection.start();

  await connection.stop();
  client.emit("disconnected"); // the real client emits this on manual disconnect
  await settle(10);
  assert.equal(reasons.length, 0);
});

test("a redelivered event logs its age and retry count", async () => {
  const client = new FakeClient();
  const { logger, lines } = collector();
  const events: InboundEvent[] = [];
  const connection = connect({ client, logger, onEvent: (event) => events.push(event) });
  connection.onDown(() => {});
  await connection.start();

  const staleTs = (Date.now() / 1000 - 360).toFixed(6); // sat out a six-minute dead window
  client.emit("slack_event", {
    ack: async () => {},
    retry_num: 1,
    body: {
      event: {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "hello?",
        ts: staleTs,
      },
    },
  });
  await settle(10);

  assert.equal(events.length, 1);
  const line = lines.find((l) => l.msg === "slack event");
  assert.ok(line);
  assert.equal(line.fields?.retryNum, 1);
  const ageMs = line.fields?.ageMs;
  assert.equal(typeof ageMs, "number");
  assert.ok((ageMs as number) >= 355_000, `delay is visible in the log (ageMs=${String(ageMs)})`);
});

test("an interactive envelope is acked and its tap reaches the engine", async () => {
  const client = new FakeClient();
  const { logger, lines } = collector();
  const events: InboundEvent[] = [];
  const connection = connect({ client, logger, onEvent: (event) => events.push(event) });
  connection.onDown(() => {});
  await connection.start();

  let acked = 0;
  client.emit("slack_event", {
    ack: async () => {
      acked += 1;
    },
    type: "interactive",
    body: {
      type: "block_actions",
      user: { id: "U1" },
      channel: { id: "D1" },
      message: { ts: "1.2", thread_ts: "1.1", text: "Which environment should I deploy to?" },
      actions: [
        { type: "button", action_id: "thicket_q:answer:0:1", block_id: "thicket_q:0", value: "0:1" },
      ],
    },
  });
  await settle(10);

  assert.equal(acked, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "block_action");
  const line = lines.find((l) => l.msg === "slack interaction");
  assert.ok(line, "the tap is logged by shape");
  assert.deepEqual(line.fields?.actions, ["thicket_q:answer:0:1"]);
  assert.equal(line.fields?.acted, "block_action");
  assert.equal(JSON.stringify(line).includes("deploy to"), false, "message content stays out of the log");
});
