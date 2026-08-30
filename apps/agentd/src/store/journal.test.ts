import test from "node:test";
import assert from "node:assert/strict";

import { TRIGGER_PHONE } from "@thicket/executor";

import { JournalStore, type JournalEntry } from "./journal.js";

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ts: "2026-08-27T10:00:00.000Z",
    agent: "hearth",
    contextId: "ctx-1",
    taskId: "task-1",
    trigger: "human",
    state: "completed",
    durationMs: 1200,
    durationApiMs: 900,
    costUsd: 0.05,
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolsUsed: ["Bash"],
    permissionDenials: [],
    queuedTurnCount: 0,
    ...overrides,
  };
}

test("a recorded turn round-trips, including tools and denials", () => {
  const store = new JournalStore(":memory:");
  store.record(entry({ permissionDenials: ["WebFetch"], error: "denied" }));
  const [row] = store.recent();
  assert.ok(row);
  assert.equal(row.agent, "hearth");
  assert.equal(row.trigger, "human");
  assert.deepEqual(row.toolsUsed, ["Bash"]);
  assert.deepEqual(row.permissionDenials, ["WebFetch"]);
  assert.equal(row.error, "denied");
  assert.equal(row.costUsd, 0.05);
  store.close();
});

test("a phone turn's row records the phone trigger and can be picked out by it", () => {
  const store = new JournalStore(":memory:");
  store.record(entry({ taskId: "slack-run" }));
  store.record(entry({ taskId: "phone-run", trigger: TRIGGER_PHONE }));

  assert.equal(store.recent({ trigger: "phone" })[0]?.taskId, "phone-run");
  assert.equal(store.recent({ trigger: "phone" })[0]?.trigger, "phone");
  assert.deepEqual(
    store.recent({ trigger: "human" }).map((row) => row.taskId),
    ["slack-run"],
  );
});

test("filters: failures only, by trigger, and by window", () => {
  const store = new JournalStore(":memory:");
  store.record(entry({ taskId: "old", ts: "2026-08-01T00:00:00.000Z" }));
  store.record(entry({ taskId: "ok" }));
  store.record(entry({ taskId: "bad", state: "failed", error: "boom" }));
  store.record(entry({ taskId: "routine-run", trigger: "routine" }));

  assert.deepEqual(
    store.recent({ failuresOnly: true }).map((row) => row.taskId),
    ["bad"],
  );
  assert.deepEqual(
    store.recent({ trigger: "routine" }).map((row) => row.taskId),
    ["routine-run"],
  );
  assert.deepEqual(
    store.recent({ sinceIso: "2026-08-20T00:00:00.000Z" }).map((row) => row.taskId),
    ["routine-run", "bad", "ok"],
    "newest first, the old row excluded",
  );
  store.close();
});

test("cost aggregates per agent over a window", () => {
  const store = new JournalStore(":memory:");
  store.record(entry({ costUsd: 0.05 }));
  store.record(entry({ costUsd: 0.03, inputTokens: 10, outputTokens: 5 }));
  store.record(entry({ agent: "forge", costUsd: 0.5 }));
  store.record(entry({ costUsd: 9.99, ts: "2026-08-01T00:00:00.000Z" }));

  const summaries = store.cost("2026-08-20T00:00:00.000Z");
  assert.deepEqual(
    summaries.map((row) => [row.agent, row.turns, Number(row.costUsd.toFixed(2))]),
    [
      ["forge", 1, 0.5],
      ["hearth", 2, 0.08],
    ],
  );
  store.close();
});

test("prune drops only rows past the retention window", () => {
  const store = new JournalStore(":memory:");
  const now = Date.parse("2026-08-27T12:00:00.000Z");
  store.record(entry({ taskId: "fresh", ts: "2026-08-27T00:00:00.000Z" }));
  store.record(entry({ taskId: "ancient", ts: "2026-01-01T00:00:00.000Z" }));

  const dropped = store.prune(90 * 24 * 60 * 60_000, now);
  assert.equal(dropped, 1);
  assert.deepEqual(store.recent().map((row) => row.taskId), ["fresh"]);
  store.close();
});
