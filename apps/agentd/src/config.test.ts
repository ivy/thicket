import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { findOnPath, loadConfig } from "./config.js";

function configDirWith(raw: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "thicket-agentd-config-"));
  const path = join(dir, "agentd.json");
  writeFileSync(path, JSON.stringify(raw));
  return path;
}

const base = { agent: "lode", allowed_peer_tags: ["tag:thicket-bridge"] };

test("a relative agents_file resolves against the config file, not the cwd", () => {
  // provision renders exactly this, meaning the roster copied in beside
  // it; agentd is started from whatever directory systemd or a rig had.
  const path = configDirWith({ ...base, agents_file: "agents.yaml" });
  assert.equal(loadConfig(path).agentsFile, join(path, "..", "agents.yaml"));
});

test("an absolute agents_file is left alone", () => {
  const path = configDirWith({ ...base, agents_file: "/etc/thicket/agents.yaml" });
  assert.equal(loadConfig(path).agentsFile, "/etc/thicket/agents.yaml");
});

test("an absent agents_file still falls back to the config dir", () => {
  const path = configDirWith(base);
  assert.match(loadConfig(path).agentsFile, /agents\.yaml$/);
});

test("claude_executable wins over whatever PATH offers", () => {
  const path = configDirWith({ ...base, claude_executable: "/opt/claude/bin/claude" });
  assert.equal(loadConfig(path).claudeExecutable, "/opt/claude/bin/claude");
});

test("findOnPath returns the first executable of that name, or nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "thicket-path-"));
  const later = mkdtempSync(join(tmpdir(), "thicket-path-"));
  writeFileSync(join(later, "widget"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(dir, "widget"), "#!/bin/sh\n", { mode: 0o755 });

  assert.equal(findOnPath("widget", [dir, later].join(delimiter)), join(dir, "widget"));
  assert.equal(findOnPath("widget", [later, dir].join(delimiter)), join(later, "widget"));
  assert.equal(findOnPath("no-such-tool", dir), undefined);
});

test("a file on PATH that is not executable is not a match", () => {
  const dir = mkdtempSync(join(tmpdir(), "thicket-path-"));
  writeFileSync(join(dir, "widget"), "not executable\n", { mode: 0o644 });
  assert.equal(findOnPath("widget", dir), undefined);
});
