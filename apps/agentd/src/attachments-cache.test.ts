import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pruneAttachments } from "./attachments-cache.js";

const DAY_MS = 24 * 60 * 60_000;

function contextDir(base: string, name: string, ageMs: number): string {
  const path = join(base, name);
  mkdirSync(join(path, "abcdef"), { recursive: true });
  writeFileSync(join(path, "abcdef", "file.csv"), "bytes");
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(path, when, when);
  return path;
}

test("stale contexts are dropped whole; fresh ones are left alone", (t) => {
  const base = mkdtempSync(join(tmpdir(), "prune-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const old = contextDir(base, "old-context", 40 * DAY_MS);
  const recent = contextDir(base, "recent-context", 1 * DAY_MS);

  return pruneAttachments(base, 30 * DAY_MS).then((dropped) => {
    assert.equal(dropped, 1);
    assert.equal(existsSync(old), false, "the whole context goes, not just its files");
    assert.equal(existsSync(recent), true);
  });
});

test("pruning a directory that was never written is not an error", async () => {
  assert.equal(await pruneAttachments(join(tmpdir(), "thicket-nonexistent-cache")), 0);
});

test("stray files beside the context directories are left alone", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "prune-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const stray = join(base, "README");
  writeFileSync(stray, "not a context");
  const when = (Date.now() - 90 * DAY_MS) / 1000;
  utimesSync(stray, when, when);

  assert.equal(await pruneAttachments(base, 30 * DAY_MS), 0);
  assert.equal(existsSync(stray), true);
});
