import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Where a one-shot came from, and where its answer goes back to. */
export interface RoutineOrigin {
  channel: string;
  threadTs: string;
  /** The origin thread's session: the run happens in it, so "XYZ" means what it meant. */
  contextId: string;
}

export interface Routine {
  id: string;
  name: string;
  /** `cron` recurs on its schedule; `at` fires once, at `atMs`, and catches up if late. */
  kind: "cron" | "at";
  /** Five-field cron for `cron` rows; "" for a one-shot. */
  cron: string;
  /** Epoch ms fire time for `at` rows; null for cron. */
  atMs: number | null;
  origin: RoutineOrigin | null;
  /** When an `at` row fired for good — after success, or after its last retry. */
  firedMs: number | null;
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
 * The agent's scheduled work, durable across restarts: standing routines
 * on cron and one-shots at a moment, in one table so listing and deleting
 * cover both. Enough run accounting lives here to tell "nothing to
 * report" from "broken for a week" — the ambiguity the silence rule
 * creates; the journal (task 025) holds the per-run detail.
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
    this.addColumn("kind", "TEXT NOT NULL DEFAULT 'cron'");
    this.addColumn("at_ms", "INTEGER");
    this.addColumn("origin_channel", "TEXT");
    this.addColumn("origin_thread_ts", "TEXT");
    this.addColumn("origin_context_id", "TEXT");
    this.addColumn("fired_ms", "INTEGER");
  }

  /**
   * CREATE TABLE IF NOT EXISTS cannot widen a table an earlier version
   * created, so added columns are applied separately and idempotently.
   */
  private addColumn(column: string, definition: string): void {
    const existing = this.db.prepare("PRAGMA table_info(routines)").all() as { name: string }[];
    if (existing.some((row) => row.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE routines ADD COLUMN ${column} ${definition}`);
  }

  close(): void {
    this.db.close();
  }

  create(routine: { name: string; cron: string; prompt: string }): Routine {
    const id = randomUUID().slice(0, 8);
    this.db
      .prepare(
        `INSERT INTO routines (id, name, kind, cron, prompt, enabled, consecutive_failures, created_ms)
         VALUES (?, ?, 'cron', ?, ?, 1, 0, ?)`,
      )
      .run(id, routine.name, routine.cron, routine.prompt, Date.now());
    return this.created(id);
  }

  /** A one-shot: fires once at `atMs`, in and back to its origin thread. */
  createOneShot(routine: {
    name: string;
    atMs: number;
    prompt: string;
    origin: RoutineOrigin;
  }): Routine {
    const id = randomUUID().slice(0, 8);
    this.db
      .prepare(
        `INSERT INTO routines (id, name, kind, cron, at_ms, origin_channel, origin_thread_ts,
           origin_context_id, prompt, enabled, consecutive_failures, created_ms)
         VALUES (?, ?, 'at', '', ?, ?, ?, ?, ?, 1, 0, ?)`,
      )
      .run(
        id,
        routine.name,
        routine.atMs,
        routine.origin.channel,
        routine.origin.threadTs,
        routine.origin.contextId,
        routine.prompt,
        Date.now(),
      );
    return this.created(id);
  }

  private created(id: string): Routine {
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

  /** Returns false when the id names nothing. A one-shot keeps its (empty) cron. */
  update(id: string, update: RoutineUpdate): boolean {
    const existing = this.get(id);
    if (existing === undefined) {
      return false;
    }
    this.db
      .prepare("UPDATE routines SET name = ?, cron = ?, prompt = ?, enabled = ? WHERE id = ?")
      .run(
        update.name ?? existing.name,
        existing.kind === "at" ? "" : (update.cron ?? existing.cron),
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

  /** A one-shot is spent: it stays listed as history and never fires again. */
  markFired(id: string, now = Date.now()): void {
    this.db.prepare("UPDATE routines SET fired_ms = ? WHERE id = ?").run(now, id);
  }

  /** Forget spent one-shots older than the journal keeps their runs. */
  pruneFired(maxAgeMs: number, now = Date.now()): number {
    const result = this.db
      .prepare("DELETE FROM routines WHERE kind = 'at' AND fired_ms IS NOT NULL AND fired_ms < ?")
      .run(now - maxAgeMs);
    return Number(result.changes);
  }
}

function toRoutine(row: Record<string, unknown>): Routine {
  const kind = row.kind === "at" ? "at" : "cron";
  const origin =
    typeof row.origin_channel === "string" &&
    typeof row.origin_thread_ts === "string" &&
    typeof row.origin_context_id === "string"
      ? {
          channel: row.origin_channel,
          threadTs: row.origin_thread_ts,
          contextId: row.origin_context_id,
        }
      : null;
  return {
    id: String(row.id),
    name: String(row.name),
    kind,
    cron: String(row.cron),
    atMs: row.at_ms === null || row.at_ms === undefined ? null : Number(row.at_ms),
    origin,
    firedMs: row.fired_ms === null || row.fired_ms === undefined ? null : Number(row.fired_ms),
    prompt: String(row.prompt),
    enabled: Number(row.enabled) === 1,
    consecutiveFailures: Number(row.consecutive_failures),
    createdMs: Number(row.created_ms),
    lastRunMs: row.last_run_ms === null ? null : Number(row.last_run_ms),
    lastOutcome: row.last_outcome === null ? null : String(row.last_outcome),
  };
}
