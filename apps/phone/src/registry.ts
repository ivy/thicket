import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

import type { PhoneSession, PhoneStatePort } from "./state.js";

export interface LockoutPolicy {
  failedCalls: number;
  windowSeconds: number;
  cooldownSeconds: number;
}

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
      CREATE TABLE IF NOT EXISTS auth_failures (
        number TEXT NOT NULL,
        at_ms  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auth_failures ON auth_failures (number, at_ms);
      CREATE TABLE IF NOT EXISTS lockouts (
        number   TEXT PRIMARY KEY,
        until_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        agent          TEXT PRIMARY KEY,
        context_id     TEXT NOT NULL,
        opened_by_call TEXT NOT NULL,
        last_active_ms INTEGER NOT NULL,
        open_task_id   TEXT
      );
      CREATE TABLE IF NOT EXISTS call_sessions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        call_sid   TEXT NOT NULL,
        agent      TEXT NOT NULL,
        context_id TEXT NOT NULL,
        started_ms INTEGER NOT NULL,
        ended_ms   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_call_sessions ON call_sessions (call_sid, started_ms);
    `);
    this.addColumn("sessions", "running_task_id", "TEXT");
  }

  private addColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
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

  /** The call reached an agent: which one, on which session. One row per session, so a switch shows both. */
  attachSession(callSid: string, agent: string, contextId: string, startedMs: number): void {
    this.db.prepare("UPDATE calls SET agent = ?, context_id = ? WHERE call_sid = ?").run(agent, contextId, callSid);
    this.db
      .prepare("INSERT INTO call_sessions (call_sid, agent, context_id, started_ms) VALUES (?, ?, ?, ?)")
      .run(callSid, agent, contextId, startedMs);
  }

  /** The session on this call with this agent ended. */
  detachSession(callSid: string, agent: string, endedMs: number): void {
    this.db
      .prepare(
        `UPDATE call_sessions SET ended_ms = ? WHERE id = (
           SELECT id FROM call_sessions WHERE call_sid = ? AND agent = ? AND ended_ms IS NULL ORDER BY started_ms DESC LIMIT 1
         )`,
      )
      .run(endedMs, callSid, agent);
  }

  /** Every session a call had, in order. */
  callSessions(callSid: string): Array<{ agent: string; contextId: string; startedMs: number; endedMs?: number }> {
    const rows = this.db
      .prepare("SELECT agent, context_id, started_ms, ended_ms FROM call_sessions WHERE call_sid = ? ORDER BY started_ms, id")
      .all(callSid) as Record<string, unknown>[];
    return rows.map((row) => ({
      agent: String(row.agent),
      contextId: String(row.context_id),
      startedMs: Number(row.started_ms),
      ...(row.ended_ms === null ? {} : { endedMs: Number(row.ended_ms) }),
    }));
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

  /** When a number's lockout ends, if it is under one now. */
  lockedUntil(number: string, nowMs: number): number | undefined {
    const row = this.db.prepare("SELECT until_ms FROM lockouts WHERE number = ? AND until_ms > ?").get(number, nowMs) as
      | { until_ms: number }
      | undefined;
    return row?.until_ms;
  }

  /**
   * A call from this number ran out of PIN attempts. Counted against the
   * window; at the limit the number is locked for the cooldown and the
   * moment that ends is returned. Old failures are pruned as they age out.
   */
  recordFailedCall(number: string, nowMs: number, policy: LockoutPolicy): number | undefined {
    this.db.prepare("DELETE FROM auth_failures WHERE at_ms < ?").run(nowMs - policy.windowSeconds * 1000);
    this.db.prepare("INSERT INTO auth_failures (number, at_ms) VALUES (?, ?)").run(number, nowMs);
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM auth_failures WHERE number = ?").get(number) as { n: number };
    if (n < policy.failedCalls) {
      return undefined;
    }
    const until = nowMs + policy.cooldownSeconds * 1000;
    this.db
      .prepare("INSERT INTO lockouts (number, until_ms) VALUES (?, ?) ON CONFLICT(number) DO UPDATE SET until_ms = excluded.until_ms")
      .run(number, until);
    this.db.prepare("DELETE FROM auth_failures WHERE number = ?").run(number);
    return until;
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
      ...(row.running_task_id === null || row.running_task_id === undefined ? {} : { runningTaskId: String(row.running_task_id) }),
    };
  }

  saveSession(session: PhoneSession): void {
    this.db
      .prepare(
        `INSERT INTO sessions (agent, context_id, opened_by_call, last_active_ms, open_task_id, running_task_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent) DO UPDATE SET
           context_id = excluded.context_id,
           opened_by_call = excluded.opened_by_call,
           last_active_ms = excluded.last_active_ms,
           open_task_id = excluded.open_task_id,
           running_task_id = excluded.running_task_id`,
      )
      .run(
        session.agent,
        session.contextId,
        session.openedByCall,
        session.lastActiveAt,
        session.openTaskId ?? null,
        session.runningTaskId ?? null,
      );
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
