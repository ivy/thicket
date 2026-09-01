import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface InFlightTask {
  taskId: string;
  agent: string;
  channel: string;
  threadTs: string;
  streamTs: string | null;
  /** ts of the Slack message that triggered the turn; the reaction target. */
  messageTs?: string | null;
  /** Slack user id of the turn's author; the stream's recipient. */
  authorId?: string | null;
  /**
   * Whether this turn engaged the thread for the first time. A turn that
   * did not was given everything said since; a turn that did was given
   * only its own message, and anything above it the agent has never seen.
   */
  opening?: boolean | null;
}

function parseIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export interface RecordedFile {
  fileId: string;
  agent: string;
  channel: string;
  threadTs: string;
  name: string;
  mimetype: string;
  size: number;
  /** Slack-private download URL; redeemable only with the bot token. */
  url: string;
}

export interface QueuedRequest {
  id: number;
  agent: string;
  channel: string;
  threadTs: string;
  text: string;
  messageTs: string;
  /** Attachments already recorded in `files`, referred to by id. */
  fileIds: string[];
  /** Slack user id of the author, for the stream's recipient on replay. */
  authorId?: string | null;
}

/** A question message awaiting a tap, keyed by the message that carries it. */
export interface PendingQuestion {
  agent: string;
  channel: string;
  /** ts of the Block Kit message the options live on. */
  messageTs: string;
  threadTs: string;
  /** The questions as posted, JSON; the shape is the executor's AgentQuestion[]. */
  questions: unknown;
}

/**
 * Bridge-local persistence: the task -> thread reverse index that routes a
 * completion arriving after a restart, agent-minted contextId overrides,
 * the offline delivery queue, and questions awaiting a tap. Nothing here
 * is agent state.
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
      CREATE TABLE IF NOT EXISTS files (
        file_id    TEXT PRIMARY KEY,
        agent      TEXT NOT NULL,
        channel    TEXT NOT NULL,
        thread_ts  TEXT NOT NULL,
        name       TEXT NOT NULL,
        mimetype   TEXT NOT NULL,
        size       INTEGER NOT NULL,
        url        TEXT NOT NULL,
        created_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS questions (
        channel    TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        agent      TEXT NOT NULL,
        thread_ts  TEXT NOT NULL,
        questions  TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        PRIMARY KEY (channel, message_ts)
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
    this.addColumn("queued", "file_ids", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("queued", "author", "TEXT");
    this.addColumn("tasks", "message_ts", "TEXT");
    this.addColumn("tasks", "author", "TEXT");
    this.addColumn("tasks", "opening", "INTEGER");
  }

  /**
   * CREATE TABLE IF NOT EXISTS cannot widen a table an earlier version
   * created, so added columns are applied separately and idempotently.
   */
  private addColumn(table: string, column: string, definition: string): void {
    const existing = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (existing.some((row) => row.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close(): void {
    this.db.close();
  }

  recordTask(task: InFlightTask): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tasks (task_id, agent, channel, thread_ts, stream_ts, message_ts, author, opening, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.taskId,
        task.agent,
        task.channel,
        task.threadTs,
        task.streamTs,
        task.messageTs ?? null,
        task.authorId ?? null,
        task.opening === undefined || task.opening === null ? null : Number(task.opening),
        Date.now(),
      );
  }

  /** null once the stream has been stopped, so it is not stopped twice. */
  setStreamTs(taskId: string, streamTs: string | null): void {
    this.db.prepare("UPDATE tasks SET stream_ts = ? WHERE task_id = ?").run(streamTs, taskId);
  }

  taskById(taskId: string): InFlightTask | undefined {
    const row = this.db
      .prepare("SELECT task_id, agent, channel, thread_ts, stream_ts, message_ts, author, opening FROM tasks WHERE task_id = ?")
      .get(taskId) as
      | {
          task_id: string;
          agent: string;
          channel: string;
          thread_ts: string;
          stream_ts: string | null;
          message_ts: string | null;
          author: string | null;
          opening: number | null;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          taskId: row.task_id,
          agent: row.agent,
          channel: row.channel,
          threadTs: row.thread_ts,
          streamTs: row.stream_ts,
          messageTs: row.message_ts,
          authorId: row.author,
          opening: row.opening === null ? null : row.opening === 1,
        };
  }

  tasksForThread(channel: string, threadTs: string): InFlightTask[] {
    const rows = this.db
      .prepare(
        "SELECT task_id, agent, channel, thread_ts, stream_ts, message_ts, author, opening FROM tasks WHERE channel = ? AND thread_ts = ? ORDER BY created_ms",
      )
      .all(channel, threadTs) as {
      task_id: string;
      agent: string;
      channel: string;
      thread_ts: string;
      stream_ts: string | null;
      message_ts: string | null;
      author: string | null;
      opening: number | null;
    }[];
    return rows.map((row) => ({
      taskId: row.task_id,
      agent: row.agent,
      channel: row.channel,
      threadTs: row.thread_ts,
      streamTs: row.stream_ts,
      messageTs: row.message_ts,
      authorId: row.author,
      opening: row.opening === null ? null : row.opening === 1,
    }));
  }

  allTasks(): InFlightTask[] {
    const rows = this.db
      .prepare("SELECT task_id, agent, channel, thread_ts, stream_ts, message_ts, author, opening FROM tasks ORDER BY created_ms")
      .all() as {
      task_id: string;
      agent: string;
      channel: string;
      thread_ts: string;
      stream_ts: string | null;
      message_ts: string | null;
      author: string | null;
      opening: number | null;
    }[];
    return rows.map((row) => ({
      taskId: row.task_id,
      agent: row.agent,
      channel: row.channel,
      threadTs: row.thread_ts,
      streamTs: row.stream_ts,
      messageTs: row.message_ts,
      authorId: row.author,
      opening: row.opening === null ? null : row.opening === 1,
    }));
  }

  removeTask(taskId: string): void {
    this.db.prepare("DELETE FROM tasks WHERE task_id = ?").run(taskId);
  }

  /** Remember an upload so the agent it was sent to can fetch it later. */
  recordFile(file: RecordedFile): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO files
           (file_id, agent, channel, thread_ts, name, mimetype, size, url, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        file.fileId,
        file.agent,
        file.channel,
        file.threadTs,
        file.name,
        file.mimetype,
        file.size,
        file.url,
        Date.now(),
      );
  }

  /**
   * The authorization check behind the file surface: an agent may fetch a
   * file only if that file was uploaded to one of its own threads, so the
   * agent name is part of the lookup rather than a test applied after it.
   */
  fileFor(agent: string, fileId: string): RecordedFile | undefined {
    const row = this.db
      .prepare(
        `SELECT file_id, agent, channel, thread_ts, name, mimetype, size, url
           FROM files WHERE agent = ? AND file_id = ?`,
      )
      .get(agent, fileId) as
      | {
          file_id: string;
          agent: string;
          channel: string;
          thread_ts: string;
          name: string;
          mimetype: string;
          size: number;
          url: string;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          fileId: row.file_id,
          agent: row.agent,
          channel: row.channel,
          threadTs: row.thread_ts,
          name: row.name,
          mimetype: row.mimetype,
          size: row.size,
          url: row.url,
        };
  }

  /** Forget descriptors older than the agent-side cache keeps files. */
  pruneFiles(olderThanMs: number): number {
    const result = this.db
      .prepare("DELETE FROM files WHERE created_ms < ?")
      .run(Date.now() - olderThanMs);
    return Number(result.changes);
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
        `INSERT INTO queued (agent, channel, thread_ts, text, message_ts, file_ids, author, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.agent,
        request.channel,
        request.threadTs,
        request.text,
        request.messageTs,
        JSON.stringify(request.fileIds),
        request.authorId ?? null,
        Date.now(),
      );
  }

  queuedFor(agent: string): QueuedRequest[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent, channel, thread_ts, text, message_ts, file_ids, author
           FROM queued WHERE agent = ? ORDER BY id`,
      )
      .all(agent) as {
      id: number;
      agent: string;
      channel: string;
      thread_ts: string;
      text: string;
      message_ts: string;
      file_ids: string;
      author: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      agent: row.agent,
      channel: row.channel,
      threadTs: row.thread_ts,
      text: row.text,
      messageTs: row.message_ts,
      fileIds: parseIds(row.file_ids),
      authorId: row.author,
    }));
  }

  dequeue(id: number): void {
    this.db.prepare("DELETE FROM queued WHERE id = ?").run(id);
  }

  /** Remember a posted question so a tap resolves it, even after a restart. */
  recordQuestion(question: PendingQuestion): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO questions (channel, message_ts, agent, thread_ts, questions, created_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        question.channel,
        question.messageTs,
        question.agent,
        question.threadTs,
        JSON.stringify(question.questions),
        Date.now(),
      );
  }

  questionFor(channel: string, messageTs: string): PendingQuestion | undefined {
    const row = this.db
      .prepare(
        "SELECT agent, thread_ts, questions FROM questions WHERE channel = ? AND message_ts = ?",
      )
      .get(channel, messageTs) as { agent: string; thread_ts: string; questions: string } | undefined;
    if (row === undefined) {
      return undefined;
    }
    let questions: unknown;
    try {
      questions = JSON.parse(row.questions);
    } catch {
      return undefined;
    }
    return { agent: row.agent, channel, messageTs, threadTs: row.thread_ts, questions };
  }

  /** Answered, or abandoned: a later tap finds nothing and is told so. */
  removeQuestion(channel: string, messageTs: string): void {
    this.db.prepare("DELETE FROM questions WHERE channel = ? AND message_ts = ?").run(channel, messageTs);
  }
}
