import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskState } from "@a2a-js/sdk";
import { InMemoryTaskStore } from "@a2a-js/sdk/server";
import type { TaskStore } from "@a2a-js/sdk/server";

import { SqliteTaskStore } from "./sqlite-task-store.js";
import { makeContext, makeTask } from "./fixtures.js";

interface StoreFactory {
  name: string;
  create(): { store: TaskStore; cleanup(): void };
}

const factories: StoreFactory[] = [
  {
    name: "InMemoryTaskStore",
    create: () => ({ store: new InMemoryTaskStore(), cleanup: () => {} }),
  },
  {
    name: "SqliteTaskStore",
    create: () => {
      const dir = mkdtempSync(join(tmpdir(), "taskstore-"));
      const store = new SqliteTaskStore(join(dir, "tasks.db"));
      return {
        store,
        cleanup: () => {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

// The same behavioral suite runs against the SDK's own InMemoryTaskStore
// and the SQLite store, proving it tests the TaskStore interface rather
// than one implementation's quirks.
for (const factory of factories) {
  test(`conformance: ${factory.name}`, async (t) => {
    const listParams = {
      tenant: "",
      contextId: "",
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageToken: "",
      statusTimestampAfter: undefined,
    };

    await t.test("load returns undefined for a missing task", async () => {
      const { store, cleanup } = factory.create();
      try {
        assert.equal(await store.load("nope", makeContext()), undefined);
      } finally {
        cleanup();
      }
    });

    await t.test("save then load round-trips deeply", async () => {
      const { store, cleanup } = factory.create();
      try {
        const ctx = makeContext();
        const task = makeTask({ id: "t1", withContent: true });
        await store.save(task, ctx);
        assert.deepEqual(await store.load("t1", ctx), task);
      } finally {
        cleanup();
      }
    });

    await t.test("save overwrites an existing task", async () => {
      const { store, cleanup } = factory.create();
      try {
        const ctx = makeContext();
        await store.save(makeTask({ id: "t1", state: TaskState.TASK_STATE_SUBMITTED }), ctx);
        const updated = makeTask({
          id: "t1",
          state: TaskState.TASK_STATE_COMPLETED,
          timestamp: "2026-08-02T11:00:00.000Z",
        });
        await store.save(updated, ctx);
        assert.deepEqual(await store.load("t1", ctx), updated);
      } finally {
        cleanup();
      }
    });

    await t.test("tasks are scoped by owner and tenant", async () => {
      const { store, cleanup } = factory.create();
      try {
        const alice = makeContext("alice");
        const bob = makeContext("bob");
        const aliceTenantX = makeContext("alice", "tenant-x");
        await store.save(makeTask({ id: "t1" }), alice);
        assert.notEqual(await store.load("t1", alice), undefined);
        assert.equal(await store.load("t1", bob), undefined);
        assert.equal(await store.load("t1", aliceTenantX), undefined);
      } finally {
        cleanup();
      }
    });

    await t.test("list filters by contextId", async () => {
      const { store, cleanup } = factory.create();
      try {
        const ctx = makeContext();
        await store.save(makeTask({ id: "a", contextId: "ctx-1" }), ctx);
        await store.save(makeTask({ id: "b", contextId: "ctx-2" }), ctx);
        await store.save(makeTask({ id: "c", contextId: "ctx-1" }), ctx);
        const res = await store.list({ ...listParams, contextId: "ctx-1" }, ctx);
        assert.deepEqual(res.tasks.map((t) => t.id).sort(), ["a", "c"]);
        assert.equal(res.totalSize, 2);
      } finally {
        cleanup();
      }
    });

    await t.test("list filters by status state", async () => {
      const { store, cleanup } = factory.create();
      try {
        const ctx = makeContext();
        await store.save(makeTask({ id: "a", state: TaskState.TASK_STATE_WORKING }), ctx);
        await store.save(makeTask({ id: "b", state: TaskState.TASK_STATE_COMPLETED }), ctx);
        const res = await store.list(
          { ...listParams, status: TaskState.TASK_STATE_WORKING },
          ctx,
        );
        assert.deepEqual(
          res.tasks.map((t) => t.id),
          ["a"],
        );
      } finally {
        cleanup();
      }
    });

    await t.test("list filters by statusTimestampAfter (strictly after)", async () => {
      const { store, cleanup } = factory.create();
      try {
        const ctx = makeContext();
        await store.save(makeTask({ id: "old", timestamp: "2026-08-01T00:00:00.000Z" }), ctx);
        await store.save(makeTask({ id: "same", timestamp: "2026-08-02T00:00:00.000Z" }), ctx);
        await store.save(makeTask({ id: "new", timestamp: "2026-08-03T00:00:00.000Z" }), ctx);
        const res = await store.list(
          { ...listParams, statusTimestampAfter: "2026-08-02T00:00:00.000Z" },
          ctx,
        );
        assert.deepEqual(
          res.tasks.map((t) => t.id),
          ["new"],
        );
      } finally {
        cleanup();
      }
    });

    await t.test("list orders newest first and paginates with cursors", async () => {
      const { store, cleanup } = factory.create();
      try {
        const ctx = makeContext();
        for (let i = 1; i <= 5; i++) {
          await store.save(
            makeTask({ id: `t${i}`, timestamp: `2026-08-0${i}T00:00:00.000Z` }),
            ctx,
          );
        }
        const page1 = await store.list({ ...listParams, pageSize: 2 }, ctx);
        assert.deepEqual(
          page1.tasks.map((t) => t.id),
          ["t5", "t4"],
        );
        assert.equal(page1.totalSize, 5);
        assert.notEqual(page1.nextPageToken, "");

        const page2 = await store.list(
          { ...listParams, pageSize: 2, pageToken: page1.nextPageToken },
          ctx,
        );
        assert.deepEqual(
          page2.tasks.map((t) => t.id),
          ["t3", "t2"],
        );

        const page3 = await store.list(
          { ...listParams, pageSize: 2, pageToken: page2.nextPageToken },
          ctx,
        );
        assert.deepEqual(
          page3.tasks.map((t) => t.id),
          ["t1"],
        );
        assert.equal(page3.nextPageToken, "");
      } finally {
        cleanup();
      }
    });

    await t.test("list omits artifacts unless includeArtifacts", async () => {
      const { store, cleanup } = factory.create();
      try {
        const ctx = makeContext();
        const task = makeTask({ id: "t1", withContent: true });
        await store.save(task, ctx);

        const without = await store.list(listParams, ctx);
        assert.deepEqual(without.tasks[0]?.artifacts, []);

        const withArtifacts = await store.list({ ...listParams, includeArtifacts: true }, ctx);
        assert.deepEqual(withArtifacts.tasks[0]?.artifacts, task.artifacts);

        // Listing must not strip artifacts from the stored task itself.
        assert.deepEqual((await store.load("t1", ctx))?.artifacts, task.artifacts);
      } finally {
        cleanup();
      }
    });

    await t.test("list rejects a malformed page token", async () => {
      const { store, cleanup } = factory.create();
      try {
        const ctx = makeContext();
        await store.save(makeTask({ id: "t1" }), ctx);
        await assert.rejects(
          store.list(
            { ...listParams, pageToken: Buffer.from("no-separator").toString("base64") },
            ctx,
          ),
          (err: Error) => /page token|cursor/i.test(err.message),
        );
      } finally {
        cleanup();
      }
    });
  });
}
