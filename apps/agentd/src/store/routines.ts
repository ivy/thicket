import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Routine {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  consecutiveFailures: number;
  createdMs: number;
  lastRunMs: number | null;
  /** Terminal state of the last run, e.g. "completed", "failed". */
  lastOutcome: string | null;
}

export interface RoutineUpdate {
  name?: string;
  cron?: string;
  prompt?: string;
  enabled?: boolean;
}

/**
 * The agent's standing work, durable across restarts: id, schedule,
 * prompt, and enough run accounting to tell "nothing to report" from
 * "broken for a week" — the ambiguity the silence rule creates. The
 * journal (task 025) holds the per-run detail; this holds the health.
 */
export class RoutineStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cron TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        created_ms INTEGER NOT NULL,
        last_run_ms INTEGER,
        last_outcome TEXT
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  create(routine: { name: string; cron: string; prompt: string }): Routine {
    const id = randomUUID().slice(0, 8);
    this.db
      .prepare(
        `INSERT INTO routines (id, name, cron, prompt, enabled, consecutive_failures, created_ms)
         VALUES (?, ?, ?, ?, 1, 0, ?)`,
      )
      .run(id, routine.name, routine.cron, routine.prompt, Date.now());
    const created = this.get(id);
    if (created === undefined) {
      throw new Error("routine insert did not persist");
    }
    return created;
  }

  get(id: string): Routine | undefined {
    const row = this.db.prepare("SELECT * FROM routines WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toRoutine(row);
  }

  list(): Routine[] {
    const rows = this.db
      .prepare("SELECT * FROM routines ORDER BY created_ms")
      .all() as Record<string, unknown>[];
    return rows.map(toRoutine);
  }

  /** Returns false when the id names nothing. */
  update(id: string, update: RoutineUpdate): boolean {
    const existing = this.get(id);
    if (existing === undefined) {
      return false;
    }
    this.db
      .prepare("UPDATE routines SET name = ?, cron = ?, prompt = ?, enabled = ? WHERE id = ?")
      .run(
        update.name ?? existing.name,
        update.cron ?? existing.cron,
        update.prompt ?? existing.prompt,
        (update.enabled ?? existing.enabled) ? 1 : 0,
        id,
      );
    if (update.enabled === true) {
      // Re-enabling is a fresh start for the failure counter.
      this.db.prepare("UPDATE routines SET consecutive_failures = 0 WHERE id = ?").run(id);
    }
    return true;
  }

  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM routines WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  /**
   * Records a run's outcome and returns the consecutive-failure count
   * after it. A success resets the count.
   */
  recordRun(id: string, outcome: string, failed: boolean, now = Date.now()): number {
    this.db
      .prepare(
        `UPDATE routines SET last_run_ms = ?, last_outcome = ?,
           consecutive_failures = CASE WHEN ? THEN consecutive_failures + 1 ELSE 0 END
         WHERE id = ?`,
      )
      .run(now, outcome, failed ? 1 : 0, id);
    return this.get(id)?.consecutiveFailures ?? 0;
  }

  disable(id: string): void {
    this.db.prepare("UPDATE routines SET enabled = 0 WHERE id = ?").run(id);
  }
}

function toRoutine(row: Record<string, unknown>): Routine {
  return {
    id: String(row.id),
    name: String(row.name),
    cron: String(row.cron),
    prompt: String(row.prompt),
    enabled: Number(row.enabled) === 1,
    consecutiveFailures: Number(row.consecutive_failures),
    createdMs: Number(row.created_ms),
    lastRunMs: row.last_run_ms === null ? null : Number(row.last_run_ms),
    lastOutcome: row.last_outcome === null ? null : String(row.last_outcome),
  };
}
