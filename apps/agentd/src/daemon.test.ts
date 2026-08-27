import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
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

test("socket activation: real daemon serves on a pre-bound fd; SIGTERM exits cleanly", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agentd-sa-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const agentsFile = join(dir, "agents.yaml");
  writeFileSync(agentsFile, AGENTS_YAML);
  const configFile = join(dir, "agentd.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      agent: "hearth",
      agents_file: agentsFile,
      allowed_peer_tags: ["tag:thicket-bridge"],
      db_path: join(dir, "tasks.db"),
      socket_path: join(dir, "unused.sock"),
    }),
  );

  // Bind the listening socket the way systemd would, then hand it to the
  // child as fd 3 with LISTEN_FDS=1.
  const activationSocket = join(dir, "activated.sock");
  const preBound = createNetServer();
  await new Promise<void>((resolve, reject) => {
    preBound.once("error", reject);
    preBound.listen(activationSocket, () => resolve());
  });
  const fd = (preBound as unknown as { _handle: { fd: number } })._handle.fd;
  assert.ok(Number.isInteger(fd) && fd > 0, "obtained listening fd");

  const child = spawn(process.execPath, [BIN], {
    env: {
      ...process.env,
      THICKET_AGENTD_CONFIG: configFile,
      LISTEN_FDS: "1",
    },
    stdio: ["ignore", "pipe", "pipe", fd],
  });
  t.after(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  });

  const childStderr = child.stderr;
  assert.ok(childStderr);
  let stderr = "";
  childStderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`daemon never came up; stderr:\n${stderr}`)),
      15_000,
    );
    const check = () => {
      if (stderr.includes("agentd listening")) {
        clearTimeout(timer);
        resolve();
      }
    };
    childStderr.on("data", check);
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(`daemon exited early (${child.exitCode}); stderr:\n${stderr}`));
    });
    check();
  });
  assert.match(stderr, /fd:3/, "daemon reports listening on the activated fd");

  // Parent must stop accepting so only the child answers, but closing a
  // net.Server unlinks its socket file. Rename first: the close's unlink
  // misses, the inode survives under the new name, and the child's
  // duplicated fd keeps serving it.
  const servedSocket = join(dir, "served.sock");
  renameSync(activationSocket, servedSocket);
  await new Promise<void>((resolve) => preBound.close(() => resolve()));

  const res = await getCard(servedSocket);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).name, "hearth");

  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  child.kill("SIGTERM");
  const code = await exited;
  assert.equal(code, 0, `clean exit; stderr:\n${stderr}`);
  assert.match(stderr, /shutdown complete/);
});
