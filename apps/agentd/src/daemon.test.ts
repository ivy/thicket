import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const BIN = fileURLToPath(new URL("./bin.js", import.meta.url));

const AGENTS_YAML = `
agents:
  hearth:
    host: home
    user: hearth
    description: Socket activation test agent.
    tag: tag:thicket-hearth
    harness:
      type: claude-agent-sdk
      cwd: /tmp
      model: claude-opus-5
`;

/** A config directory the daemon can be pointed at, plus its socket path. */
function fixture(): { dir: string; configFile: string; socketPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "agentd-daemon-"));
  const agentsFile = join(dir, "agents.yaml");
  writeFileSync(agentsFile, AGENTS_YAML);
  const socketPath = join(dir, "agentd.sock");
  const configFile = join(dir, "agentd.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      agent: "hearth",
      agents_file: agentsFile,
      allowed_peer_tags: ["tag:thicket-bridge"],
      db_path: join(dir, "tasks.db"),
      socket_path: socketPath,
    }),
  );
  return { dir, configFile, socketPath };
}

function getCard(socketPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { socketPath, path: "/.well-known/agent-card.json", method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Resolves once the daemon's stderr contains `needle`, or the child exits. */
function waitForLog(
  child: ChildProcess,
  read: () => string,
  needle: string,
): Promise<{ exited: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`never logged ${needle}; stderr:\n${read()}`)),
      15_000,
    );
    const check = () => {
      if (read().includes(needle)) {
        clearTimeout(timer);
        resolve({ exited: false });
      }
    };
    child.stderr?.on("data", check);
    child.on("exit", () => {
      clearTimeout(timer);
      check();
      resolve({ exited: true });
    });
    check();
  });
}

test("real daemon serves on the socket it creates; SIGTERM exits cleanly", async (t) => {
  const { dir, configFile, socketPath } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const child = spawn(process.execPath, [BIN], {
    env: { ...process.env, THICKET_AGENTD_CONFIG: configFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const { exited } = await waitForLog(child, () => stderr, "agentd listening");
  assert.equal(exited, false, `daemon exited early; stderr:\n${stderr}`);
  assert.ok(
    stderr.includes(`"target":"${socketPath}"`),
    `daemon reports the socket it created; stderr:\n${stderr}`,
  );

  const res = await getCard(socketPath);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).name, "hearth");

  const code = await new Promise<number | null>((resolve) => {
    child.on("exit", resolve);
    child.kill("SIGTERM");
  });
  assert.equal(code, 0, `clean exit; stderr:\n${stderr}`);
  assert.match(stderr, /shutdown complete/);
});

test("socket activation is refused loudly on a runtime that cannot adopt an fd", async (t) => {
  const { dir, configFile } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // No fd is passed: the point is that the daemon refuses before it would
  // reach for one, rather than binding nothing and answering nobody.
  const child = spawn(process.execPath, [BIN], {
    env: { ...process.env, THICKET_AGENTD_CONFIG: configFile, LISTEN_FDS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.equal(code, 1, `refuses to start; stderr:\n${stderr}`);
  assert.match(stderr, /cannot listen on a descriptor it did not open/);
  assert.match(stderr, /LISTEN_FDS/);
});
