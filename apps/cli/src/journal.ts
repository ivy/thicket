import { existsSync } from "node:fs";
import { join } from "node:path";

import { JournalStore, type CostSummary, type JournalEntry } from "@thicket/agentd";
import { stateDir } from "@thicket/roster";

export interface JournalQuery {
  /** Show per-agent cost totals instead of individual turns. */
  cost?: boolean;
  /** Only failed turns. */
  failures?: boolean;
  /** Only turns fired by this trigger (e.g. "routine"). */
  trigger?: string;
  /** Window in days; unset means all retained history. */
  days?: number;
  limit?: number;
}

export function defaultJournalPath(): string {
  return join(stateDir(), "agentd", "journal.db");
}

function sinceIso(days: number | undefined, now: number): string | undefined {
  return days === undefined ? undefined : new Date(now - days * 24 * 60 * 60_000).toISOString();
}

function money(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function formatTurn(entry: JournalEntry): string {
  const cols = [
    entry.ts,
    entry.agent,
    entry.state.padEnd(14),
    money(entry.costUsd).padStart(8),
    `${(entry.durationMs / 1000).toFixed(1)}s`.padStart(7),
    entry.trigger,
  ];
  const extras: string[] = [];
  if (entry.toolsUsed.length > 0) {
    extras.push(`tools=${entry.toolsUsed.join(",")}`);
  }
  if (entry.permissionDenials.length > 0) {
    extras.push(`denied=${entry.permissionDenials.join(",")}`);
  }
  if (entry.error !== undefined) {
    extras.push(`error=${entry.error.replace(/\s+/g, " ").slice(0, 120)}`);
  }
  return [cols.join("  "), ...extras.map((extra) => `    ${extra}`)].join("\n");
}

function formatCost(summaries: CostSummary[]): string[] {
  if (summaries.length === 0) {
    return ["no turns recorded in this window"];
  }
  return summaries.map(
    (row) =>
      `${row.agent.padEnd(16)} ${String(row.turns).padStart(5)} turns  ${money(row.costUsd).padStart(10)}  ` +
      `${row.inputTokens} in / ${row.outputTokens} out tokens`,
  );
}

/**
 * `thicket journal`: what ran, what it cost. Reads the agent account's
 * local journal — run it as the account whose agent you are asking about
 * (or point --db at a copy).
 */
export function runJournal(
  query: JournalQuery,
  dbPath: string = process.env.THICKET_JOURNAL_DB ?? defaultJournalPath(),
  now: number = Date.now(),
): { lines: string[]; exitCode: number } {
  if (dbPath !== ":memory:" && !existsSync(dbPath)) {
    return {
      lines: [
        `no journal at ${dbPath} — either no turn has run on this account yet, ` +
          `or you are not running as the agent's account (use --db to point elsewhere)`,
      ],
      exitCode: 1,
    };
  }
  const store = new JournalStore(dbPath);
  try {
    if (query.cost === true) {
      return { lines: formatCost(store.cost(sinceIso(query.days, now))), exitCode: 0 };
    }
    const entries = store.recent({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.trigger === undefined ? {} : { trigger: query.trigger }),
      ...(query.failures === true ? { failuresOnly: true } : {}),
      ...(sinceIso(query.days, now) === undefined ? {} : { sinceIso: sinceIso(query.days, now) }),
    });
    if (entries.length === 0) {
      return { lines: ["no matching turns"], exitCode: 0 };
    }
    return { lines: entries.map(formatTurn), exitCode: 0 };
  } finally {
    store.close();
  }
}

/** Parses `thicket journal` flags; returns undefined on bad usage. */
export function parseJournalArgs(args: string[]): { query: JournalQuery; db?: string } | undefined {
  const query: JournalQuery = {};
  let db: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--cost") {
      query.cost = true;
    } else if (arg === "--failures") {
      query.failures = true;
    } else if (arg === "--trigger") {
      const value = args[++i];
      if (value === undefined) {
        return undefined;
      }
      query.trigger = value;
    } else if (arg === "--days" || arg === "--limit") {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        return undefined;
      }
      if (arg === "--days") {
        query.days = value;
      } else {
        query.limit = value;
      }
    } else if (arg === "--db") {
      db = args[++i];
      if (db === undefined) {
        return undefined;
      }
    } else {
      return undefined;
    }
  }
  return { query, ...(db === undefined ? {} : { db }) };
}
