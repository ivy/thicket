import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { TaskState } from "@a2a-js/sdk";

import { CURRENT_SCHEMA_VERSION, runMigrations } from "./migrations.js";
import { SqliteTaskStore, TERMINAL_STATES } from "./sqlite-task-store.js";
import { makeContext, makeTask } from "./fixtures.js";

function tempDb(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "taskstore-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "tasks.db");
}

test("task read after reopening the database is deeply equal", async (t) => {
  const path = tempDb(t);
  const ctx = makeContext();
  const task = makeTask({ id: "persist-1", withContent: true });

  const first = new SqliteTaskStore(path);
  await first.save(task, ctx);
  first.close();

  const second = new SqliteTaskStore(path);
  try {
    const loaded = await second.load("persist-1", ctx);
    assert.deepEqual(loaded, task);
    assert.deepEqual(loaded?.artifacts, task.artifacts);
    assert.deepEqual(loaded?.history, task.history);
  } finally {
    second.close();
  }
});

test("submitted and working tasks are enumerable at startup", async (t) => {
  const path = tempDb(t);
  const store = new SqliteTaskStore(path);
  const ctxA = makeContext("alice");
  const ctxB = makeContext("bob", "tenant-x");
  await store.save(makeTask({ id: "s1", state: TaskState.TASK_STATE_SUBMITTED }), ctxA);
  await store.save(makeTask({ id: "w1", state: TaskState.TASK_STATE_WORKING }), ctxB);
  await store.save(makeTask({ id: "done", state: TaskState.TASK_STATE_COMPLETED }), ctxA);
  store.close();

  // A fresh process finds the in-flight work regardless of owner scoping.
  const reopened = new SqliteTaskStore(path);
  try {
    const inFlight = reopened.allInStates([
      TaskState.TASK_STATE_SUBMITTED,
      TaskState.TASK_STATE_WORKING,
    ]);
    assert.deepEqual(inFlight.map((task) => task.id).sort(), ["s1", "w1"]);
  } finally {
    reopened.close();
  }
});

test("concurrent writes from two connections do not corrupt state", async (t) => {
  const path = tempDb(t);
  const ctx = makeContext();
  const a = new SqliteTaskStore(path);
  const b = new SqliteTaskStore(path);
  try {
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      writes.push(a.save(makeTask({ id: `a-${i}`, withContent: true }), ctx));
      writes.push(b.save(makeTask({ id: `b-${i}`, withContent: true }), ctx));
      // Both connections also rewrite the same row.
      writes.push(a.save(makeTask({ id: "contested", timestamp: `2026-08-01T00:00:${String(i).padStart(2, "0")}.000Z` }), ctx));
      writes.push(b.save(makeTask({ id: "contested", timestamp: `2026-08-02T00:00:${String(i).padStart(2, "0")}.000Z` }), ctx));
    }
    await Promise.all(writes);

    const db = new DatabaseSync(path);
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(mode.journal_mode, "wal");
    const check = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    assert.equal(check.integrity_check, "ok");
    db.close();

    const res = await a.list(
      {
        tenant: "",
        contextId: "",
        status: TaskState.TASK_STATE_UNSPECIFIED,
        pageToken: "",
        statusTimestampAfter: undefined,
        pageSize: 100,
      },
      ctx,
    );
    assert.equal(res.totalSize, 101);
    const contested = await b.load("contested", ctx);
    assert.notEqual(contested, undefined);
  } finally {
    a.close();
    b.close();
  }
});

test("migration runner reaches current schema and is idempotent", (t) => {
  const path = tempDb(t);
  // Start from a genuinely empty file, not just a missing one.
  writeFileSync(path, "");
  const db = new DatabaseSync(path);
  runMigrations(db);
  runMigrations(db);

  const version = db
    .prepare("SELECT MAX(version) AS v FROM schema_migrations")
    .get() as { v: number };
  assert.equal(version.v, CURRENT_SCHEMA_VERSION);

  const applied = db
    .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
    .get() as { n: number };
  assert.equal(applied.n, CURRENT_SCHEMA_VERSION);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  assert.ok(tables.some((row) => row.name === "tasks"));
  db.close();

  // The store itself opens the migrated file without complaint.
  const store = new SqliteTaskStore(path);
  store.close();
});

test("pruning removes only old terminal tasks", async (t) => {
  const path = tempDb(t);
  const store = new SqliteTaskStore(path);
  const ctx = makeContext();
  const oldStamp = "2026-01-01T00:00:00.000Z";
  const freshStamp = new Date().toISOString();

  const oldTerminal: [string, TaskState][] = [
    ["old-completed", TaskState.TASK_STATE_COMPLETED],
    ["old-failed", TaskState.TASK_STATE_FAILED],
    ["old-canceled", TaskState.TASK_STATE_CANCELED],
    ["old-rejected", TaskState.TASK_STATE_REJECTED],
  ];
  const oldInterruptedOrLive: [string, TaskState][] = [
    ["old-input-required", TaskState.TASK_STATE_INPUT_REQUIRED],
    ["old-auth-required", TaskState.TASK_STATE_AUTH_REQUIRED],
    ["old-working", TaskState.TASK_STATE_WORKING],
    ["old-submitted", TaskState.TASK_STATE_SUBMITTED],
  ];
  try {
    for (const [id, state] of [...oldTerminal, ...oldInterruptedOrLive]) {
      await store.save(makeTask({ id, state, timestamp: oldStamp }), ctx);
    }
    await store.save(
      makeTask({ id: "fresh-completed", state: TaskState.TASK_STATE_COMPLETED, timestamp: freshStamp }),
    ctx);

    // Default posture: keep everything.
    assert.equal(store.pruneTerminalTasks(), 0);
    assert.equal(store.pruneTerminalTasks(undefined), 0);

    const removed = store.pruneTerminalTasks(30);
    assert.equal(removed, oldTerminal.length);
    for (const [id] of oldTerminal) {
      assert.equal(await store.load(id, ctx), undefined, `${id} should be pruned`);
    }
    for (const [id] of oldInterruptedOrLive) {
      assert.notEqual(await store.load(id, ctx), undefined, `${id} must never be pruned`);
    }
    assert.notEqual(await store.load("fresh-completed", ctx), undefined);
  } finally {
    store.close();
  }
});

test("terminal state list matches the A2A protocol", () => {
  assert.deepEqual(
    [...TERMINAL_STATES].sort(),
    [
      TaskState.TASK_STATE_COMPLETED,
      TaskState.TASK_STATE_FAILED,
      TaskState.TASK_STATE_CANCELED,
      TaskState.TASK_STATE_REJECTED,
    ].sort(),
  );
});
