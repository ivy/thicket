import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

import type { PhoneSession, PhoneStatePort } from "./state.js";

/** One call as the bridge remembers it: enough to route a wrap-up after a restart. */
export interface CallRecord {
  callSid: string;
  from: string;
  to: string;
  direction: string;
  startedMs: number;
  agent?: string;
  contextId?: string;
  endedMs?: number;
  endReason?: string;
}

/**
 * The bridge's own SQLite, beside the Slack bridge's: live and finished
 * calls, and the per-agent session the next call is offered back. Numbers
 * and identifiers live here, so the file is made owner-only like the config.
 */
export class CallRegistry implements PhoneStatePort {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") {
      chmodSync(path, 0o600);
    }
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        call_sid    TEXT PRIMARY KEY,
        from_number TEXT NOT NULL,
        to_number   TEXT NOT NULL,
        direction   TEXT NOT NULL,
        started_ms  INTEGER NOT NULL,
        agent       TEXT,
        context_id  TEXT,
        ended_ms    INTEGER,
        end_reason  TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        agent          TEXT PRIMARY KEY,
        context_id     TEXT NOT NULL,
        opened_by_call TEXT NOT NULL,
        last_active_ms INTEGER NOT NULL,
        open_task_id   TEXT
      );
    `);
  }

  recordCall(call: { callSid: string; from: string; to: string; direction: string; startedMs: number }): void {
    this.db
      .prepare(
        `INSERT INTO calls (call_sid, from_number, to_number, direction, started_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(call_sid) DO NOTHING`,
      )
      .run(call.callSid, call.from, call.to, call.direction, call.startedMs);
  }

  /** The call reached an agent: which one, on which session. */
  attachSession(callSid: string, agent: string, contextId: string): void {
    this.db.prepare("UPDATE calls SET agent = ?, context_id = ? WHERE call_sid = ?").run(agent, contextId, callSid);
  }

  /** Twilio told us the session is over; the first reason recorded wins. */
  endCall(callSid: string, endedMs: number, reason: string): boolean {
    const result = this.db
      .prepare("UPDATE calls SET ended_ms = ?, end_reason = ? WHERE call_sid = ? AND ended_ms IS NULL")
      .run(endedMs, reason, callSid);
    return result.changes > 0;
  }

  call(callSid: string): CallRecord | undefined {
    const row = this.db.prepare("SELECT * FROM calls WHERE call_sid = ?").get(callSid) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /** Calls with no end yet: what a restart may still owe a wrap-up. */
  openCalls(): CallRecord[] {
    const rows = this.db.prepare("SELECT * FROM calls WHERE ended_ms IS NULL ORDER BY started_ms").all() as Record<
      string,
      unknown
    >[];
    return rows.map(toRecord);
  }

  sessionFor(agent: string): PhoneSession | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE agent = ?").get(agent) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      agent: String(row.agent),
      contextId: String(row.context_id),
      openedByCall: String(row.opened_by_call),
      lastActiveAt: Number(row.last_active_ms),
      ...(row.open_task_id === null || row.open_task_id === undefined ? {} : { openTaskId: String(row.open_task_id) }),
    };
  }

  saveSession(session: PhoneSession): void {
    this.db
      .prepare(
        `INSERT INTO sessions (agent, context_id, opened_by_call, last_active_ms, open_task_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent) DO UPDATE SET
           context_id = excluded.context_id,
           opened_by_call = excluded.opened_by_call,
           last_active_ms = excluded.last_active_ms,
           open_task_id = excluded.open_task_id`,
      )
      .run(session.agent, session.contextId, session.openedByCall, session.lastActiveAt, session.openTaskId ?? null);
  }

  close(): void {
    this.db.close();
  }
}

function toRecord(row: Record<string, unknown>): CallRecord {
  const optional = (key: string) => (row[key] === null || row[key] === undefined ? {} : { [key]: row[key] });
  return {
    callSid: String(row.call_sid),
    from: String(row.from_number),
    to: String(row.to_number),
    direction: String(row.direction),
    startedMs: Number(row.started_ms),
    ...(row.agent === null ? {} : { agent: String(row.agent) }),
    ...(row.context_id === null ? {} : { contextId: String(row.context_id) }),
    ...(row.ended_ms === null ? {} : { endedMs: Number(row.ended_ms) }),
    ...(row.end_reason === null ? {} : { endReason: String(row.end_reason) }),
    ...optional("never"),
  };
}
