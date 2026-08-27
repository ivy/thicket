import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface InFlightTask {
  taskId: string;
  agent: string;
  channel: string;
  threadTs: string;
  streamTs: string | null;
}

export interface QueuedRequest {
  id: number;
  agent: string;
  channel: string;
  threadTs: string;
  text: string;
  messageTs: string;
}

/**
 * Bridge-local persistence: the task -> thread reverse index that routes a
 * completion arriving after a restart, agent-minted contextId overrides,
 * and the offline delivery queue. Nothing here is agent state.
 */
export class BridgeState {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id   TEXT PRIMARY KEY,
        agent     TEXT NOT NULL,
        channel   TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        stream_ts TEXT,
        created_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks (channel, thread_ts);
      CREATE TABLE IF NOT EXISTS contexts (
        channel    TEXT NOT NULL,
        thread_ts  TEXT NOT NULL,
        context_id TEXT NOT NULL,
        PRIMARY KEY (channel, thread_ts)
      );
      CREATE TABLE IF NOT EXISTS queued (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        agent      TEXT NOT NULL,
        channel    TEXT NOT NULL,
        thread_ts  TEXT NOT NULL,
        text       TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        created_ms INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  recordTask(task: InFlightTask): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tasks (task_id, agent, channel, thread_ts, stream_ts, created_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(task.taskId, task.agent, task.channel, task.threadTs, task.streamTs, Date.now());
  }

  setStreamTs(taskId: string, streamTs: string): void {
    this.db.prepare("UPDATE tasks SET stream_ts = ? WHERE task_id = ?").run(streamTs, taskId);
  }

  taskById(taskId: string): InFlightTask | undefined {
    const row = this.db
      .prepare("SELECT task_id, agent, channel, thread_ts, stream_ts FROM tasks WHERE task_id = ?")
      .get(taskId) as
      | { task_id: string; agent: string; channel: string; thread_ts: string; stream_ts: string | null }
      | undefined;
    return row === undefined
      ? undefined
      : {
          taskId: row.task_id,
          agent: row.agent,
          channel: row.channel,
          threadTs: row.thread_ts,
          streamTs: row.stream_ts,
        };
  }

  tasksForThread(channel: string, threadTs: string): InFlightTask[] {
    const rows = this.db
      .prepare(
        "SELECT task_id, agent, channel, thread_ts, stream_ts FROM tasks WHERE channel = ? AND thread_ts = ? ORDER BY created_ms",
      )
      .all(channel, threadTs) as {
      task_id: string;
      agent: string;
      channel: string;
      thread_ts: string;
      stream_ts: string | null;
    }[];
    return rows.map((row) => ({
      taskId: row.task_id,
      agent: row.agent,
      channel: row.channel,
      threadTs: row.thread_ts,
      streamTs: row.stream_ts,
    }));
  }

  allTasks(): InFlightTask[] {
    const rows = this.db
      .prepare("SELECT task_id, agent, channel, thread_ts, stream_ts FROM tasks ORDER BY created_ms")
      .all() as {
      task_id: string;
      agent: string;
      channel: string;
      thread_ts: string;
      stream_ts: string | null;
    }[];
    return rows.map((row) => ({
      taskId: row.task_id,
      agent: row.agent,
      channel: row.channel,
      threadTs: row.thread_ts,
      streamTs: row.stream_ts,
    }));
  }

  removeTask(taskId: string): void {
    this.db.prepare("DELETE FROM tasks WHERE task_id = ?").run(taskId);
  }

  /** The contextId to use for a thread: agent-minted override, if any. */
  contextFor(channel: string, threadTs: string): string | undefined {
    const row = this.db
      .prepare("SELECT context_id FROM contexts WHERE channel = ? AND thread_ts = ?")
      .get(channel, threadTs) as { context_id: string } | undefined;
    return row?.context_id;
  }

  saveContext(channel: string, threadTs: string, contextId: string): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO contexts (channel, thread_ts, context_id) VALUES (?, ?, ?)",
      )
      .run(channel, threadTs, contextId);
  }

  /** A thread is "engaged" once a context exists for it. */
  isEngaged(channel: string, threadTs: string): boolean {
    return this.contextFor(channel, threadTs) !== undefined;
  }

  enqueue(request: Omit<QueuedRequest, "id">): void {
    this.db
      .prepare(
        `INSERT INTO queued (agent, channel, thread_ts, text, message_ts, created_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.agent,
        request.channel,
        request.threadTs,
        request.text,
        request.messageTs,
        Date.now(),
      );
  }

  queuedFor(agent: string): QueuedRequest[] {
    const rows = this.db
      .prepare(
        "SELECT id, agent, channel, thread_ts, text, message_ts FROM queued WHERE agent = ? ORDER BY id",
      )
      .all(agent) as {
      id: number;
      agent: string;
      channel: string;
      thread_ts: string;
      text: string;
      message_ts: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      agent: row.agent,
      channel: row.channel,
      threadTs: row.thread_ts,
      text: row.text,
      messageTs: row.message_ts,
    }));
  }

  dequeue(id: number): void {
    this.db.prepare("DELETE FROM queued WHERE id = ?").run(id);
  }
}
