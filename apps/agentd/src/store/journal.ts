import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { TurnAccounting } from "@thicket/executor";

/** One journal row: a turn's accounting plus who ran it and when. */
export interface JournalEntry extends TurnAccounting {
  ts: string;
  agent: string;
}

export interface CostSummary {
  agent: string;
  turns: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The turn journal: one row per turn, metadata only — cost, tokens,
 * duration, tools, denials, terminal state. Never prompt or reply text;
 * that decision is task 025's and there is deliberately no flag for it.
 * Lives beside the task store with the same lifecycle.
 */
export class JournalStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        agent TEXT NOT NULL,
        context_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        fired_by TEXT NOT NULL,
        state TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        duration_api_ms INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_creation_tokens INTEGER NOT NULL,
        tools TEXT NOT NULL,
        permission_denials TEXT NOT NULL,
        error TEXT,
        queued_turn_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turns_ts ON turns (ts);
      CREATE INDEX IF NOT EXISTS turns_fired_by ON turns (fired_by, ts);
    `);
  }

  close(): void {
    this.db.close();
  }

  record(entry: JournalEntry): void {
    this.db
      .prepare(
        `INSERT INTO turns (
          ts, agent, context_id, task_id, fired_by, state,
          duration_ms, duration_api_ms, cost_usd,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          tools, permission_denials, error, queued_turn_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.ts,
        entry.agent,
        entry.contextId,
        entry.taskId,
        entry.trigger,
        entry.state,
        entry.durationMs,
        entry.durationApiMs,
        entry.costUsd,
        entry.inputTokens,
        entry.outputTokens,
        entry.cacheReadTokens,
        entry.cacheCreationTokens,
        JSON.stringify(entry.toolsUsed),
        JSON.stringify(entry.permissionDenials),
        entry.error ?? null,
        entry.queuedTurnCount,
      );
  }

  /** Most recent turns, newest first. */
  recent(options: { limit?: number; trigger?: string; failuresOnly?: boolean; sinceIso?: string } = {}): JournalEntry[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.trigger !== undefined) {
      clauses.push("fired_by = ?");
      params.push(options.trigger);
    }
    if (options.failuresOnly === true) {
      clauses.push("state = 'failed'");
    }
    if (options.sinceIso !== undefined) {
      clauses.push("ts >= ?");
      params.push(options.sinceIso);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(options.limit ?? 20);
    const rows = this.db
      .prepare(`SELECT * FROM turns ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(toEntry);
  }

  /** Cost and token totals per agent since the given instant. */
  cost(sinceIso?: string): CostSummary[] {
    const where = sinceIso !== undefined ? "WHERE ts >= ?" : "";
    const params = sinceIso !== undefined ? [sinceIso] : [];
    const rows = this.db
      .prepare(
        `SELECT agent, COUNT(*) AS turns, SUM(cost_usd) AS cost,
                SUM(input_tokens) AS input, SUM(output_tokens) AS output
         FROM turns ${where} GROUP BY agent ORDER BY cost DESC`,
      )
      .all(...params) as { agent: string; turns: number; cost: number; input: number; output: number }[];
    return rows.map((row) => ({
      agent: row.agent,
      turns: row.turns,
      costUsd: row.cost,
      inputTokens: row.input,
      outputTokens: row.output,
    }));
  }

  /** Delete rows older than maxAgeMs; returns how many were dropped. */
  prune(maxAgeMs: number, now = Date.now()): number {
    const cutoff = new Date(now - maxAgeMs).toISOString();
    const result = this.db.prepare("DELETE FROM turns WHERE ts < ?").run(cutoff);
    return Number(result.changes);
  }
}

function toEntry(row: Record<string, unknown>): JournalEntry {
  return {
    ts: String(row.ts),
    agent: String(row.agent),
    contextId: String(row.context_id),
    taskId: String(row.task_id),
    trigger: String(row.fired_by),
    state: String(row.state) as JournalEntry["state"],
    durationMs: Number(row.duration_ms),
    durationApiMs: Number(row.duration_api_ms),
    costUsd: Number(row.cost_usd),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheCreationTokens: Number(row.cache_creation_tokens),
    toolsUsed: JSON.parse(String(row.tools)) as string[],
    permissionDenials: JSON.parse(String(row.permission_denials)) as string[],
    ...(row.error === null ? {} : { error: String(row.error) }),
    queuedTurnCount: Number(row.queued_turn_count),
  };
}
