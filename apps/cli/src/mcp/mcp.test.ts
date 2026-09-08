import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as forwardRequest } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseRoster } from "@thicket/roster";

import { egressHttp } from "./http.js";
import { buildMcpServer } from "./server.js";

const ROSTER_YAML = `
agents:
  hearth:
    host: home
    user: hearth
    description: Personal assistant agent.
    tag: tag:thicket-hearth
    reach:
      operators: anyone
    skills:
      - id: triage
        name: Email triage
        description: Sorts the inbox.
        examples: ["What needs a reply?"]
    harness: { type: claude-agent-sdk, cwd: /tmp, model: claude-opus-5 }
  forbidden:
    host: vault
    user: vault
    description: An agent this caller may not reach.
    tag: tag:thicket-forbidden
    reach:
      operators: anyone
    harness: { type: claude-agent-sdk, cwd: /tmp, model: claude-opus-5 }
`;

const ROSTER = parseRoster(ROSTER_YAML);

interface StubAgent {
  server: Server;
  url: string;
  cardRequests: { ifNoneMatch?: string }[];
  rpcBodies: Record<string, unknown>[];
  /** Mutate to add a skill; bumps the ETag. */
  setSkills(skills: { id: string; name: string; description: string }[]): void;
  /** Per-context transcripts, seedable to simulate turns from Slack. */
  transcripts: Map<string, string[]>;
  authorize: boolean;
  close(): Promise<void>;
}

function startStubAgent(name: string): Promise<StubAgent> {
  let version = 1;
  let skills: { id: string; name: string; description: string }[] = [];
  const cardRequests: { ifNoneMatch?: string }[] = [];
  const rpcBodies: Record<string, unknown>[] = [];
  const transcripts = new Map<string, string[]>();
  const tasks = new Map<string, Record<string, unknown>>();

  const server = createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
      const etag = `"v${version}"`;
      const ifNoneMatch = req.headers["if-none-match"];
      cardRequests.push({ ifNoneMatch: typeof ifNoneMatch === "string" ? ifNoneMatch : undefined });
      res.setHeader("cache-control", "max-age=60");
      res.setHeader("etag", etag);
      if (ifNoneMatch === etag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          name,
          description: `${name} description`,
          skills: skills.map((s) => ({ ...s, tags: [], examples: [] })),
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/a2a/v1") {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        const body = JSON.parse(raw) as {
          id: unknown;
          method: string;
          params: Record<string, unknown>;
        };
        rpcBodies.push(body);
        res.setHeader("content-type", "application/json");
        if (!stub.authorize) {
          res.statusCode = 403;
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32000, message: "peer not authorized: tag not in allow-list" },
            }),
          );
          return;
        }
        if (body.method === "SendMessage") {
          const message = body.params.message as {
            contextId: string;
            parts: { text?: string }[];
          };
          const text = message.parts.map((p) => p.text ?? "").join("");
          const history = transcripts.get(message.contextId) ?? [];
          const reply =
            history.length > 0
              ? `recalled: ${history[0]}; answering: ${text}`
              : `answering: ${text}`;
          history.push(text);
          transcripts.set(message.contextId, history);
          const taskId = `task-${rpcBodies.length}`;
          const task = {
            id: taskId,
            contextId: message.contextId,
            status: {
              state: "TASK_STATE_COMPLETED",
              message: { parts: [{ text: reply, mediaType: "text/plain", filename: "" }] },
            },
            artifacts: [],
            history: [],
            metadata: {},
          };
          tasks.set(taskId, task);
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { task } }));
          return;
        }
        if (body.method === "GetTask") {
          const task = tasks.get(String(body.params.id));
          if (task === undefined) {
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32001, message: "task not found" },
              }),
            );
            return;
          }
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: task }));
          return;
        }
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "method not found" },
          }),
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const stub: StubAgent = {
    server,
    url: "",
    cardRequests,
    rpcBodies,
    transcripts,
    authorize: true,
    setSkills(next) {
      skills = next;
      version += 1;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("no address");
      }
      stub.url = `http://127.0.0.1:${address.port}`;
      resolve(stub);
    });
  });
}

/** Absolute-form HTTP proxy on a unix socket, standing in for netd egress. */
function startFakeEgress(socketPath: string): Promise<{ seen: string[]; close(): Promise<void> }> {
  const seen: string[] = [];
  const server = createHttpServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const target = new URL(req.url ?? "");
    const upstream = forwardRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.statusCode = 502;
      res.end("egress dial failed");
    });
    req.pipe(upstream);
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () =>
      resolve({ seen, close: () => new Promise((r) => server.close(() => r())) }),
    );
  });
}

async function connectedClient(deps: Parameters<typeof buildMcpServer>[0]): Promise<Client> {
  const server = buildMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function toolText(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content.map((c) => c.text ?? "").join("");
}

test("stdio: a configured MCP client lists the thicket tools", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rosterFile = join(dir, "agents.yaml");
  writeFileSync(rosterFile, ROSTER_YAML);

  const bin = fileURLToPath(new URL("../bin.js", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "mcp"],
    env: {
      ...process.env,
      THICKET_AGENTS_FILE: rosterFile,
      THICKET_EGRESS_SOCKET: join(dir, "egress.sock"),
    },
  });
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["agent_task_status", "ask_agent", "list_agents"],
  );
});

test("list_agents reflects an added skill after cache expiry, via conditional requests", async (t) => {
  const stub = await startStubAgent("hearth");
  t.after(() => stub.close());
  let nowMs = 1_000_000;
  // Direct doer (no proxy) keeps the cache behavior easy to observe.
  const direct = await connectedClient({
    roster: ROSTER,
    http: (spec) =>
      fetch(spec.url, { method: spec.method, headers: spec.headers, body: spec.body }).then(
        async (res) => ({
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          body: await res.text(),
        }),
      ),
    now: () => nowMs,
    endpointOverrides: { hearth: stub.url, forbidden: stub.url },
  });
  t.after(() => direct.close());

  const first = toolText(await direct.callTool({ name: "list_agents", arguments: {} }));
  assert.ok(!first.includes("Email triage"), "no skill yet");
  const requestsAfterFirst = stub.cardRequests.length;

  stub.setSkills([{ id: "triage", name: "Email triage", description: "Sorts the inbox." }]);

  // Cache still fresh: no new fetch, no new skill.
  const cached = toolText(await direct.callTool({ name: "list_agents", arguments: {} }));
  assert.ok(!cached.includes("Email triage"), "cached card served while fresh");
  assert.equal(stub.cardRequests.length, requestsAfterFirst, "no request while fresh");

  // Expire: conditional request, new card, new skill — no restart.
  nowMs += 61_000;
  const refreshed = toolText(await direct.callTool({ name: "list_agents", arguments: {} }));
  assert.ok(refreshed.includes("Email triage"), refreshed);
  const conditional = stub.cardRequests.at(-1);
  assert.ok(conditional?.ifNoneMatch !== undefined, "refetch was conditional");

  // Expire again with no change: 304 revalidation keeps the card.
  nowMs += 61_000;
  const revalidated = toolText(await direct.callTool({ name: "list_agents", arguments: {} }));
  assert.ok(revalidated.includes("Email triage"), "card retained through 304");
  assert.equal(stub.cardRequests.at(-1)?.ifNoneMatch, '"v2"');
});

test("ask_agent routes through the egress socket and returns the reply", async (t) => {
  const stub = await startStubAgent("hearth");
  t.after(() => stub.close());
  const dir = mkdtempSync(join(tmpdir(), "egress-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const egress = await startFakeEgress(join(dir, "egress.sock"));
  t.after(() => egress.close());

  const client = await connectedClient({
    roster: ROSTER,
    http: egressHttp(join(dir, "egress.sock")),
    endpointOverrides: { hearth: stub.url, forbidden: stub.url },
  });
  t.after(() => client.close());

  const result = await client.callTool({
    name: "ask_agent",
    arguments: { agent: "hearth", message: "what needs a reply today?" },
  });
  const text = toolText(result);
  assert.match(text, /answering: what needs a reply today\?/);
  assert.match(text, /task_id: task-1/);
  assert.ok(
    egress.seen.some((line) => line.startsWith("POST http://127.0.0.1")),
    `calls went through the egress proxy: ${egress.seen.join(", ")}`,
  );

  // Task status flows through the same door.
  const status = toolText(
    await client.callTool({
      name: "agent_task_status",
      arguments: { agent: "hearth", task_id: "task-1" },
    }),
  );
  assert.match(status, /TASK_STATE_COMPLETED/);
});

test("a conversation started in Slack continues via context_id with recall", async (t) => {
  const stub = await startStubAgent("hearth");
  t.after(() => stub.close());
  // Simulate earlier Slack turns in this context.
  stub.transcripts.set("slack-ctx-42", ["the launch code is PERIWINKLE"]);

  const client = await connectedClient({
    roster: ROSTER,
    http: (spec) =>
      fetch(spec.url, { method: spec.method, headers: spec.headers, body: spec.body }).then(
        async (res) => ({
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          body: await res.text(),
        }),
      ),
    endpointOverrides: { hearth: stub.url, forbidden: stub.url },
  });
  t.after(() => client.close());

  const result = toolText(
    await client.callTool({
      name: "ask_agent",
      arguments: { agent: "hearth", message: "what is the launch code?", context_id: "slack-ctx-42" },
    }),
  );
  assert.match(result, /recalled: the launch code is PERIWINKLE/);
  assert.match(result, /context_id: slack-ctx-42/);
});

test("an unauthorized agent fails with a clear authorization error, not a timeout", async (t) => {
  const stub = await startStubAgent("forbidden");
  stub.authorize = false;
  t.after(() => stub.close());

  const client = await connectedClient({
    roster: ROSTER,
    http: (spec) =>
      fetch(spec.url, { method: spec.method, headers: spec.headers, body: spec.body }).then(
        async (res) => ({
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          body: await res.text(),
        }),
      ),
    endpointOverrides: { hearth: stub.url, forbidden: stub.url },
  });
  t.after(() => client.close());

  const result = await client.callTool({
    name: "ask_agent",
    arguments: { agent: "forbidden", message: "open the vault" },
  });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(toolText(result), /not authorized/);
});

test("an unreachable agent returns a useful error promptly", async (t) => {
  const client = await connectedClient({
    roster: ROSTER,
    http: egressHttp("/tmp/definitely-missing-egress.sock"),
    endpointOverrides: {
      hearth: "http://127.0.0.1:1",
      forbidden: "http://127.0.0.1:1",
    },
  });
  t.after(() => client.close());

  const started = Date.now();
  const result = await client.callTool({
    name: "ask_agent",
    arguments: { agent: "hearth", message: "hello?" },
  });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(toolText(result), /unreachable/);
  assert.ok(Date.now() - started < 5_000, "failed promptly, no hang");
});
