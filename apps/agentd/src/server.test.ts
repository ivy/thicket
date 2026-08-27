import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Role, SendMessageRequest, GetTaskRequest, CancelTaskRequest } from "@a2a-js/sdk";
import type { Message } from "@a2a-js/sdk";
import { DefaultRequestHandler } from "@a2a-js/sdk/server";
import { ClaudeAgentExecutor, SessionManager, type QueryFn, PushQueue } from "@thicket/executor";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { toAgentCard, type AgentEntry } from "@thicket/roster";

import { buildServer } from "./server.js";
import { listen } from "./listen.js";
import type { Logger } from "./logger.js";
import { SqliteTaskStore } from "./store/sqlite-task-store.js";

const ALLOWED_TAG = "tag:thicket-bridge";

const entry: AgentEntry = {
  host: "home",
  user: "hearth",
  description: "Test agent for agentd integration tests.",
  tag: "tag:thicket-hearth",
  skills: [],
  harness: {
    type: "claude-agent-sdk",
    cwd: "/tmp",
    model: "claude-opus-5",
    sessionTtlSeconds: 300,
    permissionMode: "auto",
  },
  context: "native",
  queueing: "harness",
};

function quietLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

interface FakeCli {
  queryFn: QueryFn;
  hold: boolean;
  release(): void;
  interrupts: number;
}

function textOf(message: SDKUserMessage): string {
  return typeof message.message.content === "string" ? message.message.content : "";
}

/** Scripted stand-in for the Claude Code CLI: one streaming turn per send. */
function makeFakeCli(): FakeCli {
  const waiters: (() => void)[] = [];
  const cli: FakeCli = {
    hold: false,
    interrupts: 0,
    release() {
      for (const w of waiters.splice(0)) {
        w();
      }
    },
    queryFn: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const sessionId = options.resume ?? options.sessionId ?? "unknown";
      const out = new PushQueue<SDKMessage>();
      options.abortController?.signal.addEventListener("abort", () => out.close());
      void (async () => {
        out.push({
          type: "system",
          subtype: "init",
          capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1"],
          session_id: sessionId,
          uuid: "00000000-0000-0000-0000-000000000000",
        } as unknown as SDKMessage);
        for await (const m of prompt) {
          if (m.shouldQuery === false) {
            continue;
          }
          const reply = `echo:${textOf(m)}`;
          // Two streamed chunks, then the result.
          out.push({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: reply.slice(0, 5) },
            },
            parent_tool_use_id: null,
            user_message_uuid: m.uuid,
            uuid: "11111111-0000-0000-0000-000000000001",
            session_id: sessionId,
          } as unknown as SDKMessage);
          if (cli.hold) {
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
          out.push({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: reply.slice(5) },
            },
            parent_tool_use_id: null,
            uuid: "11111111-0000-0000-0000-000000000002",
            session_id: sessionId,
          } as unknown as SDKMessage);
          out.push({
            type: "result",
            subtype: "success",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: reply,
            stop_reason: "end_turn",
            total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: {},
            permission_denials: [],
            queued_turn_count: 0,
            user_message_uuid: m.uuid,
            uuid: "11111111-0000-0000-0000-000000000003",
            session_id: sessionId,
          } as unknown as SDKMessage);
        }
        out.close();
      })();
      const gen = (async function* () {
        for await (const frame of out) {
          yield frame;
        }
      })();
      return Object.assign(gen, {
        interrupt: async () => {
          cli.interrupts += 1;
          cli.release();
          return { still_queued: [] };
        },
      }) as unknown as Query;
    },
  };
  return cli;
}

interface Harness {
  socket: string;
  store: SqliteTaskStore;
  sessions: SessionManager;
  cli: FakeCli;
  server: Server;
  dir: string;
}

async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "agentd-"));
  const socket = join(dir, "agentd.sock");
  const cli = makeFakeCli();
  const store = new SqliteTaskStore(join(dir, "tasks.db"));
  const sessions = new SessionManager({
    harness: entry.harness,
    queryFn: cli.queryFn,
    sessionExists: async () => false,
  });
  const executor = new ClaudeAgentExecutor({ sessions });
  const card = toAgentCard("hearth", entry);
  const handler = new DefaultRequestHandler(card, store, executor);
  const app = buildServer({
    handler,
    allowedPeerTags: [ALLOWED_TAG],
    logger: quietLogger(),
  });
  const server = createServer(app);
  await listen(server, { kind: "path", path: socket });
  return { socket, store, sessions, cli, server, dir };
}

async function stopHarness(h: Harness): Promise<void> {
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
  await h.sessions.shutdown();
  h.store.close();
  rmSync(h.dir, { recursive: true, force: true });
}

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function requestOverSocket(
  socketPath: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { socketPath, path, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

function userMessage(text: string, contextId = ""): Message {
  return {
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    contextId,
    taskId: "",
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: "text", value: text },
        mediaType: "text/plain",
        filename: "",
        metadata: {},
      },
    ],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

function rpcBody(method: string, params: unknown, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function rpc(
  h: Harness,
  method: string,
  params: unknown,
  headers: Record<string, string> = { "x-thicket-peer-tags": ALLOWED_TAG },
/* eslint-disable-next-line @typescript-eslint/no-explicit-any --
   JSON-RPC responses are asserted structurally in each test. */
): Promise<{ status: number; json: { result?: any; error?: any } }> {
  const res = await requestOverSocket(h.socket, "/a2a/v1", {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0", ...headers },
    body: rpcBody(method, params),
  });
  return { status: res.status, json: JSON.parse(res.body) };
}

function sendParams(message: Message): unknown {
  return SendMessageRequest.toJSON({
    tenant: "",
    message,
    configuration: undefined,
    metadata: undefined,
  });
}

test("agent card is served with ETag and honors If-None-Match", async () => {
  const h = await startHarness();
  try {
    const first = await requestOverSocket(h.socket, "/.well-known/agent-card.json");
    assert.equal(first.status, 200);
    const etag = first.headers.etag;
    assert.ok(etag, "ETag header present");
    const card = JSON.parse(first.body);
    assert.equal(card.name, "hearth");

    const second = await requestOverSocket(h.socket, "/.well-known/agent-card.json", {
      headers: { "if-none-match": String(etag) },
    });
    assert.equal(second.status, 304);

    const mode = statSync(h.socket).mode & 0o777;
    assert.equal(mode, 0o600, "self-created socket is mode 0600");
  } finally {
    await stopHarness(h);
  }
});

test("SendMessage round trip reaches terminal state and GetTask retrieves it", async () => {
  const h = await startHarness();
  try {
    const { status, json } = await rpc(h, "SendMessage", sendParams(userMessage("hello agent")));
    assert.equal(status, 200);
    assert.equal(json.error, undefined, JSON.stringify(json.error));
    const task = json.result.task;
    assert.equal(task.status.state, "TASK_STATE_COMPLETED");
    assert.ok(task.id);

    const got = await rpc(h, "GetTask", GetTaskRequest.toJSON({ tenant: "", id: task.id, historyLength: undefined }));
    assert.equal(got.json.result.id, task.id);
    assert.equal(got.json.result.status.state, "TASK_STATE_COMPLETED");
  } finally {
    await stopHarness(h);
  }
});

test("client-supplied contextId is honored on the resulting task", async () => {
  const h = await startHarness();
  try {
    const contextId = "aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee";
    const { json } = await rpc(h, "SendMessage", sendParams(userMessage("hi", contextId)));
    assert.equal(json.result.task.contextId, contextId);
  } finally {
    await stopHarness(h);
  }
});

test("streaming yields artifact events before the terminal status event", async () => {
  const h = await startHarness();
  try {
    const res = await requestOverSocket(h.socket, "/a2a/v1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "a2a-version": "1.0",
        "x-thicket-peer-tags": ALLOWED_TAG,
      },
      body: rpcBody("SendStreamingMessage", sendParams(userMessage("stream me"))),
    });
    assert.equal(res.status, 200);
    const events = res.body
      .split("\n\n")
      .filter((block) => block.startsWith("data:"))
      .map((block) => JSON.parse(block.slice(5)));
    const payloads = events.map((e) => e.result ?? e);
    const kinds = payloads.map((p) =>
      p.task ? "task" : p.statusUpdate ? "statusUpdate" : p.artifactUpdate ? "artifactUpdate" : "msg",
    );
    const firstArtifact = kinds.indexOf("artifactUpdate");
    const lastStatus = kinds.lastIndexOf("statusUpdate");
    assert.notEqual(firstArtifact, -1, `no artifact events in ${JSON.stringify(kinds)}`);
    assert.ok(firstArtifact < lastStatus, "artifacts stream before the terminal status");
    const terminal = payloads[lastStatus].statusUpdate;
    assert.equal(terminal.status.state, "TASK_STATE_COMPLETED");
  } finally {
    await stopHarness(h);
  }
});

test("absent or unknown peer tags are rejected with an A2A error, not a 500", async () => {
  const h = await startHarness();
  try {
    const absent = await rpc(h, "SendMessage", sendParams(userMessage("x")), {});
    assert.equal(absent.status, 403);
    assert.equal(absent.json.error.code, -32000);
    assert.match(absent.json.error.message, /peer identity missing/);

    const unknown = await rpc(h, "SendMessage", sendParams(userMessage("x")), {
      "x-thicket-peer-tags": "tag:thicket-stranger",
    });
    assert.equal(unknown.status, 403);
    assert.match(unknown.json.error.message, /not authorized/);
  } finally {
    await stopHarness(h);
  }
});

test("CancelTask interrupts a running turn; the task reaches canceled", async () => {
  const h = await startHarness();
  h.cli.hold = true;
  try {
    // Streaming send so the request does not block on the held turn.
    const streamed = requestOverSocket(h.socket, "/a2a/v1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "a2a-version": "1.0",
        "x-thicket-peer-tags": ALLOWED_TAG,
      },
      body: rpcBody("SendStreamingMessage", sendParams(userMessage("slow job"))),
    });

    // Wait for the task to exist and be working.
    let taskId = "";
    for (let i = 0; i < 200 && taskId === ""; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const list = h.store.allInStates([1, 2]);
      if (list.length > 0) {
        taskId = list[0]!.id;
      }
    }
    assert.notEqual(taskId, "", "task reached the store");

    const canceled = await rpc(
      h,
      "CancelTask",
      CancelTaskRequest.toJSON({ tenant: "", id: taskId, metadata: undefined }),
    );
    assert.equal(canceled.json.error, undefined, JSON.stringify(canceled.json.error));
    assert.equal(canceled.json.result.status.state, "TASK_STATE_CANCELED");
    assert.equal(h.cli.interrupts, 1, "interrupt reached the session");

    await streamed;
    const after = await rpc(h, "GetTask", GetTaskRequest.toJSON({ tenant: "", id: taskId, historyLength: undefined }));
    assert.equal(after.json.result.status.state, "TASK_STATE_CANCELED");
  } finally {
    await stopHarness(h);
  }
});
