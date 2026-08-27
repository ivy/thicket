import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  sql: string;
}

// Forward-only. Never edit a released migration; append a new version.
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE tasks (
        tenant           TEXT NOT NULL,
        owner            TEXT NOT NULL,
        id               TEXT NOT NULL,
        context_id       TEXT NOT NULL,
        state            INTEGER NOT NULL,
        status_timestamp TEXT,
        status_time_ms   INTEGER,
        task_json        TEXT NOT NULL,
        PRIMARY KEY (tenant, owner, id)
      );
      CREATE INDEX idx_tasks_context ON tasks (tenant, owner, context_id);
      CREATE INDEX idx_tasks_state ON tasks (tenant, owner, state);
    `,
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * Bring db to the current schema. Idempotent: applied versions are recorded
 * in schema_migrations and skipped on later runs.
 */
export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const row = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as { version: number };
  const applied = row.version;

  for (const migration of MIGRATIONS) {
    if (migration.version <= applied) {
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
