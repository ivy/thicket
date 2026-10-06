import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { GatewaySession, SessionStore } from "./gateway.js";

/** One step on a card, as rendered. */
export interface CardStep {
  id: string;
  title: string;
  status: "running" | "done" | "failed";
}

/**
 * A turn card as it currently reads. An edit replaces the whole message,
 * so the bridge keeps the rendering it last flushed; a restart edits the
 * same card from this record rather than rebuilding it from the agent.
 */
export interface CardRecord {
  messageId: string;
  status: string;
  steps: CardStep[];
  text: string;
}

export interface InFlightTask {
  taskId: string;
  agent: string;
  /** The channel the card is in: a thread, or a DM channel. */
  channel: string;
  /** Id of the message that triggered the turn; the reply target. */
  triggerId?: string | null;
  /** Discord user id of the turn's author. */
  authorId?: string | null;
  card: CardRecord | null;
}

export interface RecordedFile {
  fileId: string;
  agent: string;
  channel: string;
  /** Message the attachment arrived on; refetched for a fresh URL when the signed one expires. */
  messageId: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
  /** Set once an ephemeral upload has been saved locally; the path under the bridge's state dir. */
  localPath?: string | null;
}

export interface QueuedRequest {
  id: number;
  agent: string;
  channel: string;
  text: string;
  messageId: string;
  fileIds: string[];
  authorId?: string | null;
}

export interface PendingQuestion {
  agent: string;
  channel: string;
  /** Id of the question card. */
  messageId: string;
  /** The questions as posted, JSON; the shape is the executor's AgentQuestion[]. */
  questions: unknown;
  /** Picks so far, per question index. */
  picks: Record<string, string[]>;
}

export interface ContextRow {
  contextId: string;
  /** Whether this agent answers unmentioned messages in the channel. */
  answerer: boolean;
  /** The guild channel a thread hangs from, once looked up; the DM channel itself in a DM. */
  parent: string | null;
}

function parseIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Bridge-local persistence: the task → channel reverse index that routes a
 * completion arriving after a restart, each card as last rendered, the
 * Gateway session a restart resumes, contexts and who answers in them,
 * attachments, the offline delivery queue, questions awaiting a tap, and
 * the message ids already handled. Nothing here is agent state.
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
        task_id    TEXT PRIMARY KEY,
        agent      TEXT NOT NULL,
        channel    TEXT NOT NULL,
        trigger_id TEXT,
        author     TEXT,
        card       TEXT,
        created_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks (channel);
      CREATE TABLE IF NOT EXISTS contexts (
        agent      TEXT NOT NULL,
        channel    TEXT NOT NULL,
        context_id TEXT NOT NULL,
        answerer   INTEGER NOT NULL DEFAULT 0,
        parent     TEXT,
        PRIMARY KEY (agent, channel)
      );
      CREATE TABLE IF NOT EXISTS files (
        file_id      TEXT PRIMARY KEY,
        agent        TEXT NOT NULL,
        channel      TEXT NOT NULL,
        message_id   TEXT NOT NULL,
        name         TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size         INTEGER NOT NULL,
        url          TEXT NOT NULL,
        local_path   TEXT,
        created_ms   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS questions (
        agent      TEXT NOT NULL,
        channel    TEXT NOT NULL,
        message_id TEXT NOT NULL,
        questions  TEXT NOT NULL,
        picks      TEXT NOT NULL DEFAULT '{}',
        created_ms INTEGER NOT NULL,
        PRIMARY KEY (channel, message_id)
      );
      CREATE TABLE IF NOT EXISTS queued (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        agent      TEXT NOT NULL,
        channel    TEXT NOT NULL,
        text       TEXT NOT NULL,
        message_id TEXT NOT NULL,
        file_ids   TEXT NOT NULL DEFAULT '[]',
        author     TEXT,
        created_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        agent      TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        resume_url TEXT NOT NULL,
        seq        INTEGER,
        user_id    TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS handled (
        agent      TEXT NOT NULL,
        message_id TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        PRIMARY KEY (agent, message_id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------------ tasks

  recordTask(task: InFlightTask): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tasks (task_id, agent, channel, trigger_id, author, card, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.taskId,
        task.agent,
        task.channel,
        task.triggerId ?? null,
        task.authorId ?? null,
        task.card === null ? null : JSON.stringify(task.card),
        Date.now(),
      );
  }

  /** The card as last flushed; null once the task has no live card. */
  setCard(taskId: string, card: CardRecord | null): void {
    this.db
      .prepare("UPDATE tasks SET card = ? WHERE task_id = ?")
      .run(card === null ? null : JSON.stringify(card), taskId);
  }

  taskById(taskId: string): InFlightTask | undefined {
    const row = this.db
      .prepare("SELECT task_id, agent, channel, trigger_id, author, card FROM tasks WHERE task_id = ?")
      .get(taskId) as TaskRow | undefined;
    return row === undefined ? undefined : taskOf(row);
  }

  tasksForChannel(agent: string, channel: string): InFlightTask[] {
    const rows = this.db
      .prepare("SELECT task_id, agent, channel, trigger_id, author, card FROM tasks WHERE agent = ? AND channel = ? ORDER BY created_ms")
      .all(agent, channel) as unknown as TaskRow[];
    return rows.map(taskOf);
  }

  allTasks(): InFlightTask[] {
    const rows = this.db
      .prepare("SELECT task_id, agent, channel, trigger_id, author, card FROM tasks ORDER BY created_ms")
      .all() as unknown as TaskRow[];
    return rows.map(taskOf);
  }

  removeTask(taskId: string): void {
    this.db.prepare("DELETE FROM tasks WHERE task_id = ?").run(taskId);
  }

  // --------------------------------------------------------------- contexts

  contextFor(agent: string, channel: string): ContextRow | undefined {
    const row = this.db
      .prepare("SELECT context_id, answerer, parent FROM contexts WHERE agent = ? AND channel = ?")
      .get(agent, channel) as { context_id: string; answerer: number; parent: string | null } | undefined;
    return row === undefined
      ? undefined
      : { contextId: row.context_id, answerer: row.answerer === 1, parent: row.parent };
  }

  saveContext(agent: string, channel: string, row: ContextRow): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO contexts (agent, channel, context_id, answerer, parent) VALUES (?, ?, ?, ?, ?)",
      )
      .run(agent, channel, row.contextId, row.answerer ? 1 : 0, row.parent);
  }

  /** A channel is engaged once this agent holds a context for it. */
  isEngaged(agent: string, channel: string): boolean {
    return this.contextFor(agent, channel) !== undefined;
  }

  // ------------------------------------------------------------------ files

  recordFile(file: RecordedFile): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO files
           (file_id, agent, channel, message_id, name, content_type, size, url, local_path, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        file.fileId,
        file.agent,
        file.channel,
        file.messageId,
        file.name,
        file.contentType,
        file.size,
        file.url,
        file.localPath ?? null,
        Date.now(),
      );
  }

  /** A signed URL refreshed after the message was refetched. */
  setFileUrl(fileId: string, url: string): void {
    this.db.prepare("UPDATE files SET url = ? WHERE file_id = ?").run(url, fileId);
  }

  /**
   * The authorization check behind the file surface: an agent may fetch a
   * file only if it arrived in one of its own conversations, so the agent
   * name is part of the lookup rather than a test applied after it.
   */
  fileFor(agent: string, fileId: string): RecordedFile | undefined {
    const row = this.db
      .prepare(
        `SELECT file_id, agent, channel, message_id, name, content_type, size, url, local_path
           FROM files WHERE agent = ? AND file_id = ?`,
      )
      .get(agent, fileId) as FileRow | undefined;
    return row === undefined ? undefined : fileOf(row);
  }

  /** Forget descriptors older than the retention; returns the local paths freed. */
  pruneFiles(olderThanMs: number): string[] {
    const floor = Date.now() - olderThanMs;
    const rows = this.db
      .prepare("SELECT local_path FROM files WHERE created_ms < ? AND local_path IS NOT NULL")
      .all(floor) as { local_path: string }[];
    this.db.prepare("DELETE FROM files WHERE created_ms < ?").run(floor);
    return rows.map((row) => row.local_path);
  }

  // ------------------------------------------------------------------ queue

  enqueue(request: Omit<QueuedRequest, "id">): void {
    this.db
      .prepare(
        `INSERT INTO queued (agent, channel, text, message_id, file_ids, author, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.agent,
        request.channel,
        request.text,
        request.messageId,
        JSON.stringify(request.fileIds),
        request.authorId ?? null,
        Date.now(),
      );
  }

  queuedFor(agent: string): QueuedRequest[] {
    const rows = this.db
      .prepare("SELECT id, agent, channel, text, message_id, file_ids, author FROM queued WHERE agent = ? ORDER BY id")
      .all(agent) as {
      id: number;
      agent: string;
      channel: string;
      text: string;
      message_id: string;
      file_ids: string;
      author: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      agent: row.agent,
      channel: row.channel,
      text: row.text,
      messageId: row.message_id,
      fileIds: parseIds(row.file_ids),
      authorId: row.author,
    }));
  }

  dequeue(id: number): void {
    this.db.prepare("DELETE FROM queued WHERE id = ?").run(id);
  }

  // -------------------------------------------------------------- questions

  recordQuestion(question: PendingQuestion): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO questions (agent, channel, message_id, questions, picks, created_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        question.agent,
        question.channel,
        question.messageId,
        JSON.stringify(question.questions),
        JSON.stringify(question.picks),
        Date.now(),
      );
  }

  questionFor(channel: string, messageId: string): PendingQuestion | undefined {
    const row = this.db
      .prepare("SELECT agent, questions, picks FROM questions WHERE channel = ? AND message_id = ?")
      .get(channel, messageId) as { agent: string; questions: string; picks: string } | undefined;
    if (row === undefined) {
      return undefined;
    }
    const questions = parseJson<unknown>(row.questions, undefined);
    if (questions === undefined) {
      return undefined;
    }
    return {
      agent: row.agent,
      channel,
      messageId,
      questions,
      picks: parseJson<Record<string, string[]>>(row.picks, {}),
    };
  }

  /** A pick is recorded as it happens; Discord keeps no state on the message. */
  setPicks(channel: string, messageId: string, picks: Record<string, string[]>): void {
    this.db
      .prepare("UPDATE questions SET picks = ? WHERE channel = ? AND message_id = ?")
      .run(JSON.stringify(picks), channel, messageId);
  }

  removeQuestion(channel: string, messageId: string): void {
    this.db.prepare("DELETE FROM questions WHERE channel = ? AND message_id = ?").run(channel, messageId);
  }

  // ------------------------------------------------------------- the session

  /** The Gateway session for one agent, persisted so a restart resumes it. */
  sessions(agent: string): SessionStore {
    return {
      load: (): GatewaySession | undefined => {
        const row = this.db
          .prepare("SELECT session_id, resume_url, seq, user_id FROM sessions WHERE agent = ?")
          .get(agent) as { session_id: string; resume_url: string; seq: number | null; user_id: string } | undefined;
        return row === undefined
          ? undefined
          : { sessionId: row.session_id, resumeUrl: row.resume_url, seq: row.seq, userId: row.user_id };
      },
      save: (session: GatewaySession): void => {
        this.db
          .prepare("INSERT OR REPLACE INTO sessions (agent, session_id, resume_url, seq, user_id) VALUES (?, ?, ?, ?, ?)")
          .run(agent, session.sessionId, session.resumeUrl, session.seq, session.userId);
      },
      clear: (): void => {
        this.db.prepare("DELETE FROM sessions WHERE agent = ?").run(agent);
      },
    };
  }

  // ---------------------------------------------------------------- handled

  /**
   * Delivery is at least once, so the engine asks before acting. Returns
   * true the first time a message id is seen and records it; a repeat is
   * a redelivery after a resume and is dropped.
   */
  markHandled(agent: string, messageId: string): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO handled (agent, message_id, created_ms) VALUES (?, ?, ?)")
      .run(agent, messageId, Date.now());
    return Number(result.changes) === 1;
  }

  pruneHandled(olderThanMs: number): number {
    const result = this.db.prepare("DELETE FROM handled WHERE created_ms < ?").run(Date.now() - olderThanMs);
    return Number(result.changes);
  }
}

interface TaskRow {
  task_id: string;
  agent: string;
  channel: string;
  trigger_id: string | null;
  author: string | null;
  card: string | null;
}

function taskOf(row: TaskRow): InFlightTask {
  return {
    taskId: row.task_id,
    agent: row.agent,
    channel: row.channel,
    triggerId: row.trigger_id,
    authorId: row.author,
    card: parseJson<CardRecord | null>(row.card, null),
  };
}

interface FileRow {
  file_id: string;
  agent: string;
  channel: string;
  message_id: string;
  name: string;
  content_type: string;
  size: number;
  url: string;
  local_path: string | null;
}

function fileOf(row: FileRow): RecordedFile {
  return {
    fileId: row.file_id,
    agent: row.agent,
    channel: row.channel,
    messageId: row.message_id,
    name: row.name,
    contentType: row.content_type,
    size: row.size,
    url: row.url,
    localPath: row.local_path,
  };
}
