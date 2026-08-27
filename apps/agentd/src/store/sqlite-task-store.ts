import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Role, Task, TaskState } from "@a2a-js/sdk";
import type { ListTasksRequest, ListTasksResponse } from "@a2a-js/sdk";
import type { OwnerResolver, ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import { resolveUserScope } from "@a2a-js/sdk/server";
import { RequestMalformedError } from "@a2a-js/sdk/errors";

import { runMigrations } from "./migrations.js";

const DEFAULT_PAGE_SIZE = 50;

export const TERMINAL_STATES: readonly TaskState[] = [
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
];

export interface SqliteTaskStoreOptions {
  ownerResolver?: OwnerResolver;
}

interface TaskRow {
  task_json: string;
}

/**
 * SQLite-backed {@link TaskStore}. Persists the full Task (status,
 * artifacts, history, metadata) through the SDK's Task JSON codec so a
 * reopened database returns tasks deep-equal to what was saved. Scoped by
 * (tenant, owner) with the same semantics as the SDK's InMemoryTaskStore.
 */
export class SqliteTaskStore implements TaskStore {
  private readonly db: DatabaseSync;
  private readonly ownerResolver: OwnerResolver;

  constructor(path: string, options: SqliteTaskStoreOptions = {}) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    // WAL allows a reader and a writer concurrently; busy_timeout makes a
    // second writer queue instead of failing with SQLITE_BUSY.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    runMigrations(this.db);
    this.ownerResolver = options.ownerResolver ?? resolveUserScope;
  }

  close(): void {
    this.db.close();
  }

  private scope(context: ServerCallContext): { tenant: string; owner: string } {
    return { tenant: context.tenant ?? "", owner: this.ownerResolver(context) };
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    const { tenant, owner } = this.scope(context);
    const timestamp = task.status?.timestamp;
    const timeMs =
      timestamp !== undefined && !Number.isNaN(Date.parse(timestamp))
        ? Date.parse(timestamp)
        : null;
    this.db
      .prepare(
        `INSERT INTO tasks (tenant, owner, id, context_id, state, status_timestamp, status_time_ms, task_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant, owner, id) DO UPDATE SET
           context_id = excluded.context_id,
           state = excluded.state,
           status_timestamp = excluded.status_timestamp,
           status_time_ms = excluded.status_time_ms,
           task_json = excluded.task_json`,
      )
      .run(
        tenant,
        owner,
        task.id,
        task.contextId,
        task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
        timestamp ?? null,
        timeMs,
        JSON.stringify(Task.toJSON(task)),
      );
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const { tenant, owner } = this.scope(context);
    const row = this.db
      .prepare("SELECT task_json FROM tasks WHERE tenant = ? AND owner = ? AND id = ?")
      .get(tenant, owner, taskId) as TaskRow | undefined;
    return row === undefined ? undefined : Task.fromJSON(JSON.parse(row.task_json));
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const {
      contextId,
      status,
      pageSize = DEFAULT_PAGE_SIZE,
      pageToken,
      statusTimestampAfter,
      includeArtifacts = false,
    } = params;
    const { tenant, owner } = this.scope(context);

    const conditions = ["tenant = ?", "owner = ?"];
    const args: (string | number)[] = [tenant, owner];
    if (contextId) {
      conditions.push("context_id = ?");
      args.push(contextId);
    }
    if (status !== undefined && status !== TaskState.TASK_STATE_UNSPECIFIED) {
      conditions.push("state = ?");
      args.push(status);
    }
    if (statusTimestampAfter) {
      // Strictly-after on the parsed instant, matching InMemoryTaskStore.
      conditions.push("status_time_ms IS NOT NULL AND status_time_ms > ?");
      args.push(Date.parse(statusTimestampAfter));
    }

    // Newest first; ISO-8601 UTC strings sort chronologically as bytes.
    // Cursor logic below mirrors InMemoryTaskStore exactly (including the
    // unknown-cursor -> empty page behavior), so both stores paginate
    // identically under the shared conformance suite.
    const rows = this.db
      .prepare(
        `SELECT id, COALESCE(status_timestamp, '') AS ts, task_json FROM tasks
         WHERE ${conditions.join(" AND ")}
         ORDER BY COALESCE(status_timestamp, '') DESC, id DESC`,
      )
      .all(...args) as { id: string; ts: string; task_json: string }[];

    const totalSize = rows.length;
    let remaining = rows;
    if (pageToken) {
      const decoded = Buffer.from(pageToken, "base64").toString("utf-8");
      const [cursorTimestamp, ...idParts] = decoded.split("|");
      if (idParts.length === 0) {
        throw new RequestMalformedError({ message: "Invalid page token format." });
      }
      const cursorId = idParts.join("|");
      const cursorIndex = rows.findIndex((r) => r.ts === cursorTimestamp && r.id === cursorId);
      remaining = cursorIndex === -1 ? [] : rows.slice(cursorIndex + 1);
    }

    const page = remaining.slice(0, pageSize);
    const tasks = page.map((row) => {
      const task = Task.fromJSON(JSON.parse(row.task_json));
      if (!includeArtifacts) {
        task.artifacts = [];
      }
      return task;
    });

    let nextPageToken = "";
    if (page.length > 0 && remaining.length > page.length) {
      const last = page[page.length - 1]!;
      nextPageToken = Buffer.from(`${last.ts}|${last.id}`).toString("base64");
    }

    return { tasks, nextPageToken, pageSize, totalSize };
  }

  /**
   * Every stored task currently in one of states, across all tenants and
   * owners — agentd's startup reconciliation sweep (task 008), not part of
   * the caller-scoped TaskStore interface.
   */
  allInStates(states: readonly TaskState[]): Task[] {
    if (states.length === 0) {
      return [];
    }
    const placeholders = states.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT task_json FROM tasks WHERE state IN (${placeholders}) ORDER BY rowid`)
      .all(...states) as unknown as TaskRow[];
    return rows.map((row) => Task.fromJSON(JSON.parse(row.task_json)));
  }

  /**
   * Startup reconciliation: tasks left in submitted/working by a previous
   * process are unrecoverable — their subprocess is gone. Fail them with
   * an explanatory message so clients are not left polling forever.
   * Returns the number of tasks transitioned.
   */
  failUnfinished(reason: string): number {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT tenant, owner, id, task_json FROM tasks WHERE state IN (?, ?)`,
      )
      .all(TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING) as unknown as {
      tenant: string;
      owner: string;
      id: string;
      task_json: string;
    }[];
    const update = this.db.prepare(
      `UPDATE tasks SET state = ?, status_timestamp = ?, status_time_ms = ?, task_json = ?
       WHERE tenant = ? AND owner = ? AND id = ?`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const task = Task.fromJSON(JSON.parse(row.task_json));
        task.status = {
          state: TaskState.TASK_STATE_FAILED,
          message: {
            messageId: `${row.id}-reconciled`,
            contextId: task.contextId,
            taskId: row.id,
            role: Role.ROLE_AGENT,
            parts: [
              {
                content: { $case: "text", value: reason },
                mediaType: "text/plain",
                filename: "",
                metadata: {},
              },
            ],
            metadata: {},
            extensions: [],
            referenceTaskIds: [],
          },
          timestamp: now,
        };
        update.run(
          TaskState.TASK_STATE_FAILED,
          now,
          Date.parse(now),
          JSON.stringify(Task.toJSON(task)),
          row.tenant,
          row.owner,
          row.id,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return rows.length;
  }

  /**
   * Deletes terminal tasks whose status timestamp is older than
   * olderThanDays. Non-terminal tasks — including the interrupted states
   * input-required and auth-required — are never pruned. Returns the number
   * of tasks removed. undefined keeps everything (the default posture).
   */
  pruneTerminalTasks(olderThanDays?: number): number {
    if (olderThanDays === undefined) {
      return 0;
    }
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
      throw new RangeError(`olderThanDays must be a non-negative number, got ${olderThanDays}`);
    }
    const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const placeholders = TERMINAL_STATES.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `DELETE FROM tasks
         WHERE state IN (${placeholders})
           AND status_time_ms IS NOT NULL
           AND status_time_ms < ?`,
      )
      .run(...TERMINAL_STATES, cutoffMs);
    return Number(result.changes);
  }
}
