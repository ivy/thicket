import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JournalStore, type JournalEntry } from "@thicket/agentd";

import { parseJournalArgs, runJournal } from "./journal.js";

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ts: "2026-08-27T10:00:00.000Z",
    agent: "hearth",
    contextId: "ctx-1",
    taskId: "task-1",
    trigger: "human",
    state: "completed",
    durationMs: 1200,
    durationApiMs: 900,
    costUsd: 0.05,
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolsUsed: [],
    permissionDenials: [],
    queuedTurnCount: 0,
    ...overrides,
  };
}

function seededDb(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "journal-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "journal.db");
  const store = new JournalStore(path);
  store.record(entry({ taskId: "t-ok", toolsUsed: ["Bash"] }));
  store.record(entry({ taskId: "t-bad", state: "failed", error: "exploded", costUsd: 0.01 }));
  store.record(entry({ taskId: "t-routine", trigger: "routine", costUsd: 0.02 }));
  store.close();
  return path;
}

test("flag parsing accepts the documented flags and rejects junk", () => {
  assert.deepEqual(parseJournalArgs([]), { query: {} });
  assert.deepEqual(parseJournalArgs(["--cost", "--days", "7"]), {
    query: { cost: true, days: 7 },
  });
  assert.deepEqual(parseJournalArgs(["--trigger", "routine", "--limit", "5"]), {
    query: { trigger: "routine", limit: 5 },
  });
  assert.equal(parseJournalArgs(["--bogus"]), undefined);
  assert.equal(parseJournalArgs(["--days", "zero"]), undefined);
});

test("recent turns are listed with cost, and failures carry their error", (t) => {
  const db = seededDb(t);
  const { lines, exitCode } = runJournal({}, db);
  assert.equal(exitCode, 0);
  assert.equal(lines.length, 3);
  assert.match(lines.join("\n"), /\$0\.0500/);
  assert.match(lines.join("\n"), /tools=Bash/);

  const failures = runJournal({ failures: true }, db);
  assert.equal(failures.lines.length, 1);
  assert.match(failures.lines[0]!, /failed/);
  assert.match(failures.lines[0]!, /error=exploded/);
});

test("cost mode aggregates per agent; trigger mode shows a routine's history", (t) => {
  const db = seededDb(t);
  const cost = runJournal({ cost: true, days: 30 }, db, Date.parse("2026-08-28T00:00:00.000Z"));
  assert.equal(cost.lines.length, 1);
  assert.match(cost.lines[0]!, /^hearth\s+3 turns\s+\$0\.0800/);

  const routine = runJournal({ trigger: "routine" }, db);
  assert.equal(routine.lines.length, 1);
  assert.match(routine.lines[0]!, /routine/);
});

test("a missing journal names the path and the likely reason", () => {
  const { lines, exitCode } = runJournal({}, "/nowhere/journal.db");
  assert.equal(exitCode, 1);
  assert.match(lines[0]!, /no journal at \/nowhere\/journal\.db/);
});
