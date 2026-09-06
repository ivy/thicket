import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseRoster } from "@thicket/roster";

import type { HttpDoer } from "./mcp/http.js";
import { parseSendArgs, resolveRoute, runSend, SEND_EXIT, type SendDeps } from "./send.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "bin.ts");

const ROSTER = parseRoster(`
agents:
  ops:
    host: thicket-host
    user: thicket-ops
    description: The operator's own agent.
    tag: tag:thicket-ops
    harness: { type: claude-agent-sdk, cwd: /home/thicket-ops, model: claude-opus-5 }
  media:
    host: thicket-host
    user: thicket-media
    description: The media zone agent.
    tag: tag:thicket-media
    harness: { type: claude-agent-sdk, cwd: /home/thicket-media, model: claude-sonnet-5 }
`);

interface Seen {
  headers: Record<string, string | string[] | undefined>;
  body: { params: Record<string, unknown> };
}

interface StubAgent {
  server: Server;
  seen: Seen[];
  /** What the next SendMessage answers with. */
  reply: { state: string; text: string } | { status: number; message: string };
  close(): Promise<void>;
}

/** Answers SendMessage the way agentd's JSON-RPC surface does, and remembers what it was asked. */
function stubAgent(): StubAgent {
  const seen: Seen[] = [];
  const stub: StubAgent = {
    seen,
    reply: { state: "TASK_STATE_COMPLETED", text: "done" },
    server: createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        const body = JSON.parse(raw) as { id: unknown; params: Record<string, unknown> };
        seen.push({ headers: req.headers, body });
        res.setHeader("content-type", "application/json");
        if ("status" in stub.reply) {
          res.statusCode = stub.reply.status;
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32000, message: stub.reply.message },
            }),
          );
          return;
        }
        const message = body.params.message as { contextId: string };
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              task: {
                id: `task-${seen.length}`,
                contextId: message.contextId,
                status: {
                  state: stub.reply.state,
                  message: { parts: [{ text: stub.reply.text, mediaType: "text/plain", filename: "" }] },
                },
                artifacts: [],
              },
            },
          }),
        );
      });
    }),
    close: () => new Promise((resolve) => stub.server.close(() => resolve())),
  };
  return stub;
}

/**
 * `thicket send` as a script runs it, with the message on stdin. Spawned
 * asynchronously on purpose: the stub agent lives in this process, and a
 * synchronous spawn would hold the event loop it needs to answer.
 */
function runBin(
  args: string[],
  input: string,
  env: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** The peer route's door, without netd: a plain dial of the URL. */
function directHttp(): HttpDoer {
  return (spec) =>
    new Promise((resolve, reject) => {
      const url = new URL(spec.url);
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: spec.method,
          headers: spec.headers,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => (body += chunk.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      if (spec.body !== undefined) {
        req.write(spec.body);
      }
      req.end();
    });
}

function deps(overrides: Partial<SendDeps>): SendDeps & { lines: { out: string[]; err: string[] } } {
  const lines = { out: [] as string[], err: [] as string[] };
  return {
    roster: ROSTER,
    localUser: "thicket-ops",
    out: (line) => lines.out.push(line),
    err: (line) => lines.err.push(line),
    lines,
    ...overrides,
  };
}

test("send arguments: the agent, an optional message, and two flags", () => {
  assert.deepEqual(parseSendArgs(["ops", "review it"]), {
    agent: "ops",
    message: "review it",
    wait: false,
  });
  // No message, or `-`, means stdin.
  assert.deepEqual(parseSendArgs(["ops"]), { agent: "ops", wait: false });
  assert.deepEqual(parseSendArgs(["ops", "-"]), { agent: "ops", wait: false });
  assert.deepEqual(parseSendArgs(["--wait", "--context", "ctx-9", "media", "hi"]), {
    agent: "media",
    message: "hi",
    wait: true,
    contextId: "ctx-9",
  });
  // Nothing to send to, an unknown flag, a dangling --context, a third word: usage.
  assert.equal(parseSendArgs([]), undefined);
  assert.equal(parseSendArgs(["--wait"]), undefined);
  assert.equal(parseSendArgs(["--verbose", "ops", "hi"]), undefined);
  assert.equal(parseSendArgs(["ops", "hi", "--context"]), undefined);
  assert.equal(parseSendArgs(["ops", "hi", "there"]), undefined);
});

test("the route is the local socket for this account's agent and the tailnet for every other", () => {
  const d = deps({ local: { agent: "ops", socketPath: "/run/x/agentd.sock" }, tailnetDomain: "tail42.ts.net" });
  assert.deepEqual(resolveRoute(d, "ops"), { kind: "local", socketPath: "/run/x/agentd.sock" });
  assert.deepEqual(resolveRoute(d, "media"), {
    kind: "peer",
    rpcUrl: "https://thicket-media.tail42.ts.net/a2a/v1",
  });
  // An override names the endpoint outright, as it does for mcp and fleet.
  assert.deepEqual(
    resolveRoute({ ...d, endpointOverrides: { media: "http://127.0.0.1:9" } }, "media"),
    { kind: "peer", rpcUrl: "http://127.0.0.1:9/a2a/v1" },
  );
  // No local agent at all: the account's own name still goes out through netd.
  assert.equal(resolveRoute(deps({ tailnetDomain: "tail42.ts.net" }), "ops").kind, "peer");
  assert.throws(() => resolveRoute(d, "nobody"), /unknown agent "nobody"; roster has: ops, media/);
});

test("a same-account send opens agentd's socket, names its user, and exits on acceptance", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "send-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "agentd.sock");
  const agent = stubAgent();
  await new Promise<void>((resolve) => agent.server.listen(socketPath, resolve));
  t.after(() => agent.close());
  // The turn is still running when a script wants its prompt back.
  agent.reply = { state: "TASK_STATE_SUBMITTED", text: "" };

  const d = deps({ local: { agent: "ops", socketPath } });
  const code = await runSend(
    { agent: "ops", wait: false },
    "media pushed proposal/media/base-change; review it",
    d,
  );
  assert.equal(code, SEND_EXIT.ok, d.lines.err.join("\n"));
  assert.deepEqual(d.lines.out, ["ops accepted task task-1 (context " + String(
    (agent.seen[0]!.body.params.message as { contextId: string }).contextId,
  ) + ")"]);
  assert.deepEqual(d.lines.err, []);

  const [request] = agent.seen;
  assert.ok(request);
  // Identity: the caller's own name, on the header only a socket-opener can set.
  assert.equal(request.headers["x-thicket-local-user"], "thicket-ops");
  assert.equal(request.headers["x-thicket-peer-tags"], undefined, "no tag is asserted locally");
  // Fire-and-forget is the protocol's own flag, not a client-side timeout.
  assert.deepEqual(request.body.params.configuration, { returnImmediately: true });
  const message = request.body.params.message as {
    messageId: string;
    parts: { text: string }[];
    metadata: Record<string, unknown>;
  };
  assert.match(message.messageId, /^send-/);
  assert.equal(message.parts[0]!.text, "media pushed proposal/media/base-change; review it");
  assert.deepEqual(message.metadata, {
    "thicket.trigger": "send",
    "thicket.sender": "thicket-ops",
    "thicket.unattended": true,
  });
});

test("--wait prints the reply on stdout, the coordinates on stderr, and the state as the exit code", async (t) => {
  const agent = stubAgent();
  await new Promise<void>((resolve) => agent.server.listen(0, "127.0.0.1", resolve));
  t.after(() => agent.close());
  const address = agent.server.address();
  assert.ok(address !== null && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const d = deps({ peerHttp: directHttp(), endpointOverrides: { media: base } });
  agent.reply = { state: "TASK_STATE_COMPLETED", text: "pulled and applied" };
  assert.equal(
    await runSend({ agent: "media", wait: true, contextId: "ctx-nightly" }, "main changed; pull", d),
    SEND_EXIT.ok,
  );
  assert.deepEqual(d.lines.out, ["pulled and applied"]);
  assert.deepEqual(d.lines.err, ["[media | task task-1 | context ctx-nightly | TASK_STATE_COMPLETED]"]);
  const message = agent.seen[0]!.body.params.message as { contextId: string; metadata: Record<string, unknown> };
  assert.equal(message.contextId, "ctx-nightly", "a named context continues a conversation");
  assert.equal(message.metadata["thicket.unattended"], false);
  assert.equal(agent.seen[0]!.body.params.configuration, undefined, "a waiting send blocks");
  assert.equal(agent.seen[0]!.headers["x-thicket-local-user"], undefined, "the peer route asserts nothing");

  // The agent took the message and could not finish: the script learns that from $?.
  agent.reply = { state: "TASK_STATE_FAILED", text: "turn interrupted" };
  const failed = deps({ peerHttp: directHttp(), endpointOverrides: { media: base } });
  assert.equal(await runSend({ agent: "media", wait: true }, "x", failed), SEND_EXIT.failed);
  assert.deepEqual(failed.lines.out, ["turn interrupted"]);
  assert.match(failed.lines.err[0]!, /TASK_STATE_FAILED\]$/);
});

test("a message that never reaches the agent is a distinct exit code, with the reason", async (t) => {
  const agent = stubAgent();
  await new Promise<void>((resolve) => agent.server.listen(0, "127.0.0.1", resolve));
  t.after(() => agent.close());
  const address = agent.server.address();
  assert.ok(address !== null && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const unknown = deps({});
  assert.equal(await runSend({ agent: "nobody", wait: false }, "x", unknown), SEND_EXIT.undelivered);
  assert.match(unknown.lines.err[0]!, /unknown agent "nobody"/);

  // A laptop with no netd and no agent of its own has no way to reach media.
  const unrouted = deps({ tailnetDomain: "tail42.ts.net" });
  assert.equal(await runSend({ agent: "media", wait: false }, "x", unrouted), SEND_EXIT.undelivered);
  assert.match(unrouted.lines.err[0]!, /no route to media/);

  const refused = deps({ peerHttp: directHttp(), endpointOverrides: { media: base } });
  agent.reply = { status: 403, message: "peer not authorized: tags [tag:thicket-ops] are not in this agent's allow-list" };
  assert.equal(await runSend({ agent: "media", wait: false }, "x", refused), SEND_EXIT.undelivered);
  assert.match(refused.lines.err[0]!, /^media: not authorized: peer not authorized/);

  const down = deps({ peerHttp: directHttp(), endpointOverrides: { media: "http://127.0.0.1:1" } });
  assert.equal(await runSend({ agent: "media", wait: false }, "x", down), SEND_EXIT.undelivered);
  assert.match(down.lines.err[0]!, /^media: agent unreachable at http:\/\/127\.0\.0\.1:1\/a2a\/v1/);
  assert.deepEqual(down.lines.out, []);
});

// The shape a git hook uses: the message on stdin, the agent found through
// this account's own agentd config, nothing else on the command line.
test("thicket send reads stdin and finds this account's agent through agentd.json", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "send-bin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "agentd.sock");
  const agent = stubAgent();
  await new Promise<void>((resolve) => agent.server.listen(socketPath, resolve));
  t.after(() => agent.close());

  const rosterPath = join(dir, "agents.yaml");
  writeFileSync(
    rosterPath,
    "agents:\n  ops:\n    host: thicket-host\n    user: thicket-ops\n    description: The operator's agent.\n" +
      "    tag: tag:thicket-ops\n    harness: { type: claude-agent-sdk, cwd: /home/thicket-ops, model: claude-opus-5 }\n",
  );
  const configPath = join(dir, "agentd.json");
  writeFileSync(
    configPath,
    JSON.stringify({ agent: "ops", allowed_peer_tags: ["tag:thicket-bridge"], socket_path: socketPath }),
  );
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    THICKET_AGENTS_FILE: rosterPath,
    THICKET_AGENTD_CONFIG: configPath,
    THICKET_EGRESS_SOCKET: join(dir, "no-such-egress.sock"),
    XDG_CONFIG_HOME: join(dir, "empty-config"),
  };

  const run = await runBin(["send", "ops"], "principal=media ref=refs/heads/proposal/media/base-change\n", env);
  assert.equal(run.status, SEND_EXIT.ok, run.stderr);
  assert.match(run.stdout, /^ops accepted task task-1 \(context [0-9a-f-]{36}\)\n$/);
  assert.equal(
    (agent.seen[0]!.body.params.message as { parts: { text: string }[] }).parts[0]!.text,
    "principal=media ref=refs/heads/proposal/media/base-change",
    "the trailing newline a pipe adds is not part of the message",
  );

  const empty = await runBin(["send", "ops"], "\n", env);
  assert.equal(empty.status, SEND_EXIT.usage);
  assert.match(empty.stderr, /message is empty/);

  const usage = await runBin(["send"], "", env);
  assert.equal(usage.status, SEND_EXIT.usage);
  assert.match(usage.stderr, /thicket send \[--wait\]/);
});
