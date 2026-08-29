import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config.js";

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
