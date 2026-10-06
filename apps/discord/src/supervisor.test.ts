import test from "node:test";
import assert from "node:assert/strict";

import { ConnectionSupervisor, type Connection } from "./supervisor.js";

class FakeConnection implements Connection {
  started = 0;
  stopped = 0;
  private down: ((reason: string) => void) | null = null;

  constructor(private readonly failFirstStart = false) {}

  async start(): Promise<void> {
    this.started += 1;
    if (this.failFirstStart && this.started === 1) {
      throw new Error("first connect refused");
    }
  }
  async stop(): Promise<void> {
    this.stopped += 1;
  }
  onDown(handler: (reason: string) => void): void {
    this.down = handler;
  }
  drop(reason = "network blip"): void {
    this.down?.(reason);
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

test("a dropped connection reconnects; other agents' connections are untouched", async () => {
  const made = new Map<string, FakeConnection[]>();
  const factory = (agent: string) => {
    const connection = new FakeConnection();
    made.set(agent, [...(made.get(agent) ?? []), connection]);
    return connection;
  };
  const supervisor = new ConnectionSupervisor({
    agents: ["hearth", "forge"],
    factory,
    backoffMs: [5],
  });
  await supervisor.start();
  assert.equal(supervisor.connectedCount, 2);

  // hearth's connection dies; the process and forge's connection live on.
  made.get("hearth")![0]!.drop();
  assert.equal(supervisor.connectedCount, 1);
  await settle();

  assert.equal(made.get("hearth")!.length, 2, "hearth got a fresh connection");
  assert.equal(made.get("forge")!.length, 1, "forge's connection untouched");
  assert.equal(supervisor.connectedCount, 2);
  await supervisor.stop();
});

test("a failing connect keeps retrying with backoff until it succeeds", async () => {
  const connections: FakeConnection[] = [];
  let failures = 2;
  const factory = () => {
    const connection = new FakeConnection(failures-- > 0);
    connections.push(connection);
    return connection;
  };
  const supervisor = new ConnectionSupervisor({
    agents: ["hearth"],
    factory,
    backoffMs: [5],
  });
  await supervisor.start();
  await settle();
  assert.equal(supervisor.connectedCount, 1, "eventually connected");
  assert.ok(connections.length >= 3, `retried (${connections.length} attempts)`);
  await supervisor.stop();
});
