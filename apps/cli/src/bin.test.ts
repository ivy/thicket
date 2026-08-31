import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "bin.ts");

const YAML = `
agents:
  hearth:
    host: home
    user: hearth
    description: Personal assistant agent.
    tag: tag:thicket-hearth
    harness: { type: claude-agent-sdk, cwd: /home/hearth, model: claude-opus-5 }
  forge:
    host: workshop
    user: forge
    description: CI fixer agent.
    tag: tag:thicket-forge
    harness: { type: claude-agent-sdk, cwd: /home/forge, model: claude-sonnet-5 }
`;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function render(args: string[], env: Record<string, string>): Promise<Run> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      out[path.slice(dir.length + 1)] = readFileSync(path, "utf8");
    }
  }
  return out;
}

// A deployer regenerates config far more often than it provisions Slack, and
// must never risk doing the second while meaning the first. So the command
// runs with no Slack credential anywhere and touches nothing but --out.
test("render writes the per-account tree with no Slack credential in reach", async (t) => {
  const work = mkdtempSync(join(tmpdir(), "render-cmd-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const rosterPath = join(work, "agents.yaml");
  writeFileSync(rosterPath, YAML);
  const out = join(work, "out");

  const run = await render(["render", "--out", out], {
    THICKET_AGENTS_FILE: rosterPath,
    THICKET_TAILNET_DOMAIN: "tail42.ts.net",
    XDG_CONFIG_HOME: join(work, "empty-config"),
  });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /rendered \d+ per-account config files/);

  const files = tree(out);
  assert.deepEqual(
    Object.keys(files).sort(),
    [
      "forge/agentd.json",
      "forge/agents.yaml",
      "forge/netd.json",
      "hearth/agentd.json",
      "hearth/agents.yaml",
      "hearth/netd.json",
    ],
  );

  const netd = JSON.parse(files["hearth/netd.json"]!) as { egress_allow: string[]; tag: string };
  assert.equal(netd.tag, "tag:thicket-hearth");
  assert.deepEqual(netd.egress_allow, [
    "thicket-bridge.tail42.ts.net",
    "thicket-hearth.tail42.ts.net",
    "thicket-forge.tail42.ts.net",
  ]);

  const agentd = JSON.parse(files["hearth/agentd.json"]!) as { allowed_peer_tags: string[] };
  assert.deepEqual(agentd.allowed_peer_tags, [
    "tag:thicket-bridge",
    "tag:thicket-hearth",
    "tag:thicket-forge",
  ]);

  // Re-rendering over the tree is what a re-run of a deploy does.
  const again = await render(["render", "--out", out], {
    THICKET_AGENTS_FILE: rosterPath,
    THICKET_TAILNET_DOMAIN: "tail42.ts.net",
    XDG_CONFIG_HOME: join(work, "empty-config"),
  });
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(tree(out), files, "a second render produced different bytes");
});

test("render without a directory after --out refuses rather than guessing", async (t) => {
  const work = mkdtempSync(join(tmpdir(), "render-cmd-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const rosterPath = join(work, "agents.yaml");
  writeFileSync(rosterPath, YAML);

  const run = await render(["render", "--out"], {
    THICKET_AGENTS_FILE: rosterPath,
    XDG_CONFIG_HOME: join(work, "empty-config"),
  });
  assert.equal(run.code, 2);
  assert.match(run.stderr, /--out needs a directory/);
});
