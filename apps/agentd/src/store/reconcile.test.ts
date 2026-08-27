import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskState } from "@a2a-js/sdk";

import { SqliteTaskStore } from "./sqlite-task-store.js";
import { makeContext, makeTask } from "./fixtures.js";

test("restart reconciliation fails submitted/working tasks, never leaves working", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "tasks.db");
  const ctx = makeContext();

  const before = new SqliteTaskStore(path);
  await before.save(makeTask({ id: "in-flight", state: TaskState.TASK_STATE_WORKING }), ctx);
  await before.save(makeTask({ id: "queued", state: TaskState.TASK_STATE_SUBMITTED }), ctx);
  await before.save(makeTask({ id: "finished", state: TaskState.TASK_STATE_COMPLETED }), ctx);
  await before.save(
    makeTask({ id: "waiting", state: TaskState.TASK_STATE_INPUT_REQUIRED }),
    ctx,
  );
  // Simulate the daemon dying with work in flight.
  before.close();

  const after = new SqliteTaskStore(path);
  const count = after.failUnfinished("agentd restarted; the running turn was lost");
  assert.equal(count, 2);

  const inFlight = await after.load("in-flight", ctx);
  assert.equal(inFlight?.status?.state, TaskState.TASK_STATE_FAILED);
  const part = inFlight?.status?.message?.parts[0];
  assert.ok(part?.content?.$case === "text");
  assert.match(part.content.value, /restarted/);

  assert.equal((await after.load("queued", ctx))?.status?.state, TaskState.TASK_STATE_FAILED);
  // Terminal and interrupted states are untouched.
  assert.equal(
    (await after.load("finished", ctx))?.status?.state,
    TaskState.TASK_STATE_COMPLETED,
  );
  assert.equal(
    (await after.load("waiting", ctx))?.status?.state,
    TaskState.TASK_STATE_INPUT_REQUIRED,
  );

  assert.equal(after.allInStates([TaskState.TASK_STATE_WORKING]).length, 0);
  // Idempotent: a second reconciliation finds nothing.
  assert.equal(after.failUnfinished("again"), 0);
  after.close();
});
