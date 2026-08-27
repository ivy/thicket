import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { PushQueue } from "./push-queue.js";
import { SessionManager, type QueryFn } from "./session-manager.js";
import type { SessionHandle } from "./types.js";

const TTL_S = 300;
const TTL_MS = TTL_S * 1000;

interface FakeProcess {
  id: number;
  options: Options;
  received: SDKUserMessage[];
  interrupts: number;
  ended: boolean;
  aborted: boolean;
}

interface FakeCli {
  queryFn: QueryFn;
  processes: FakeProcess[];
  /** Simulated ~/.claude transcript store, keyed by session id. */
  transcripts: Map<string, string[]>;
  /** When true, turns do not answer until release() is called. */
  hold: boolean;
  release(): void;
  /** When set, the next spawned process dies right after this many frames. */
  crashAfterSends?: number;
}

function textOf(message: SDKUserMessage): string {
  return typeof message.message.content === "string" ? message.message.content : "";
}

function makeFakeCli(): FakeCli {
  const processes: FakeProcess[] = [];
  const transcripts = new Map<string, string[]>();
  const waiters: (() => void)[] = [];
  const cli: FakeCli = {
    processes,
    transcripts,
    hold: false,
    release() {
      for (const w of waiters.splice(0)) {
        w();
      }
    },
    queryFn: ({ prompt, options }) => {
      const proc: FakeProcess = {
        id: processes.length,
        options,
        received: [],
        interrupts: 0,
        ended: false,
        aborted: false,
      };
      processes.push(proc);
      const sessionId = options.resume ?? options.sessionId ?? "unknown";
      // Only a resumed process can see the prior transcript — a fresh
      // sessionId spawn starts blank, like the real CLI.
      const known: string[] =
        options.resume !== undefined ? [...(transcripts.get(options.resume) ?? [])] : [];
      const out = new PushQueue<SDKMessage>();
      options.abortController?.signal.addEventListener("abort", () => {
        proc.aborted = true;
        proc.ended = true;
        out.close();
      });
      void (async () => {
        for await (const m of prompt) {
          proc.received.push(m);
          known.push(textOf(m));
          transcripts.set(sessionId, [...known]);
          if (m.shouldQuery === false) {
            continue;
          }
          if (cli.hold) {
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
          const reply = `seen:[${known.slice(0, -1).join("|")}] answering:${textOf(m)}`;
          out.push({
            type: "assistant",
            message: {
              id: `msg_${proc.id}`,
              type: "message",
              role: "assistant",
              model: "claude-opus-5",
              content: [{ type: "text", text: reply }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
            parent_tool_use_id: null,
            user_message_uuid: m.uuid,
            uuid: `aaaaaaaa-0000-0000-0000-${String(proc.id).padStart(12, "0")}`,
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
            uuid: `bbbbbbbb-0000-0000-0000-${String(proc.id).padStart(12, "0")}`,
            session_id: sessionId,
          } as unknown as SDKMessage);
        }
        proc.ended = true;
        out.close();
      })();
      const gen = (async function* () {
        for await (const frame of out) {
          yield frame;
        }
      })();
      return Object.assign(gen, {
        interrupt: async () => {
          proc.interrupts += 1;
          return { still_queued: [] };
        },
      }) as unknown as Query;
    },
  };
  return cli;
}

function makeManager(cli: FakeCli, overrides: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) {
  return new SessionManager({
    harness: { cwd: "/home/hearth", model: "claude-opus-5", sessionTtlSeconds: TTL_S },
    queryFn: cli.queryFn,
    sessionExists: async (id) => cli.transcripts.has(id),
    ...overrides,
  });
}

function userMessage(text: string, uuid: string, shouldQuery?: boolean): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid: uuid as SDKUserMessage["uuid"],
    ...(shouldQuery === undefined ? {} : { shouldQuery }),
  };
}

/** Background-drains a session's frames into an array. */
function collect(session: SessionHandle): SDKMessage[] {
  const frames: SDKMessage[] = [];
  void (async () => {
    for await (const frame of session.frames) {
      frames.push(frame);
    }
  })();
  return frames;
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function results(frames: SDKMessage[]): SDKMessage[] {
  return frames.filter((f) => f.type === "result");
}

test("hot session reuses the same subprocess (process identity)", async () => {
  const cli = makeFakeCli();
  const manager = makeManager(cli);
  const session = manager.sessionFor("ctx-hot");
  const frames = collect(session);

  await session.send(userMessage("first", "u1"));
  await until(() => results(frames).length === 1, "first result");
  const firstQuery = manager.currentQuery("ctx-hot");
  assert.notEqual(firstQuery, undefined);

  await session.send(userMessage("second", "u2"));
  await until(() => results(frames).length === 2, "second result");

  assert.equal(cli.processes.length, 1, "one subprocess for both turns");
  assert.equal(manager.currentQuery("ctx-hot"), firstQuery, "same Query object");
  assert.equal(cli.processes[0]?.received.length, 2);
  await manager.shutdown();
});

test("idle eviction fires at the configured TTL and not before", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cli = makeFakeCli();
  const manager = makeManager(cli);
  const session = manager.sessionFor("ctx-ttl");
  const frames = collect(session);

  await session.send(userMessage("hello", "u1"));
  await until(() => results(frames).length === 1, "result");

  t.mock.timers.tick(TTL_MS - 1);
  await until(() => true, "settle");
  assert.notEqual(manager.currentQuery("ctx-ttl"), undefined, "still hot before TTL");

  t.mock.timers.tick(1);
  await until(() => manager.currentQuery("ctx-ttl") === undefined, "evicted at TTL");
  await until(() => cli.processes[0]?.ended === true, "subprocess exited");
  await manager.shutdown();
});

test("evicted session resumes prior context and recalls the fact", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cli = makeFakeCli();
  const manager = makeManager(cli);
  const session = manager.sessionFor("ctx-recall");
  const frames = collect(session);

  await session.send(userMessage("the launch code is PERIWINKLE", "u1"));
  await until(() => results(frames).length === 1, "first result");
  assert.equal(cli.processes[0]?.options.sessionId, "ctx-recall", "fresh start uses sessionId");
  assert.equal(cli.processes[0]?.options.resume, undefined);

  t.mock.timers.tick(TTL_MS);
  await until(() => manager.currentQuery("ctx-recall") === undefined, "evicted");
  await until(() => cli.processes[0]?.ended === true, "old subprocess exited");

  await session.send(userMessage("what is the launch code?", "u2"));
  await until(() => results(frames).length === 2, "resumed result");

  assert.equal(cli.processes.length, 2, "cold start spawned a new subprocess");
  assert.equal(cli.processes[1]?.options.resume, "ctx-recall", "cold start resumes by id");
  const resumed = results(frames)[1] as { result: string };
  assert.match(resumed.result, /PERIWINKLE/, "resumed turn recalls the fact");
  await manager.shutdown();
});

test("a session mid-turn is not evicted at TTL; eviction happens after settle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cli = makeFakeCli();
  cli.hold = true;
  const manager = makeManager(cli);
  const session = manager.sessionFor("ctx-busy");
  const frames = collect(session);

  await session.send(userMessage("slow question", "u1"));
  await until(() => cli.processes[0]?.received.length === 1, "message delivered");

  t.mock.timers.tick(TTL_MS);
  await until(() => true, "settle");
  assert.notEqual(manager.currentQuery("ctx-busy"), undefined, "busy session survives TTL");

  cli.hold = false;
  cli.release();
  await until(() => results(frames).length === 1, "turn settled");

  t.mock.timers.tick(TTL_MS);
  await until(() => manager.currentQuery("ctx-busy") === undefined, "evicted after settle");
  await manager.shutdown();
});

test("pool cap evicts least-recently-used idle session instead of refusing", async () => {
  const cli = makeFakeCli();
  const manager = makeManager(cli, { maxSessions: 2 });

  const a = manager.sessionFor("ctx-a");
  const b = manager.sessionFor("ctx-b");
  const c = manager.sessionFor("ctx-c");
  const framesA = collect(a);
  const framesB = collect(b);
  const framesC = collect(c);

  await a.send(userMessage("a1", "ua"));
  await until(() => results(framesA).length === 1, "a settled");
  await b.send(userMessage("b1", "ub"));
  await until(() => results(framesB).length === 1, "b settled");
  assert.equal(manager.hotCount, 2);

  await c.send(userMessage("c1", "uc"));
  await until(() => results(framesC).length === 1, "c settled");

  assert.equal(manager.hotCount, 2, "cap enforced");
  assert.equal(manager.currentQuery("ctx-a"), undefined, "LRU (a) evicted");
  assert.notEqual(manager.currentQuery("ctx-b"), undefined);
  assert.notEqual(manager.currentQuery("ctx-c"), undefined);
  await manager.shutdown();
});

test("shouldQuery:false is context for the next turn, not a turn of its own", async () => {
  const cli = makeFakeCli();
  const manager = makeManager(cli);
  const session = manager.sessionFor("ctx-ambient");
  const frames = collect(session);

  await session.send(userMessage("fyi: the deploy window is Friday", "u1", false));
  await until(() => cli.processes[0]?.received.length === 1, "ambient message delivered");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(results(frames).length, 0, "no turn triggered");

  await session.send(userMessage("when is the deploy window?", "u2"));
  await until(() => results(frames).length === 1, "turn settled");
  const reply = results(frames)[0] as { result: string };
  assert.match(reply.result, /deploy window is Friday/, "ambient message visible in context");
  assert.equal(results(frames).length, 1, "exactly one turn for two sends");
  await manager.shutdown();
});

test("subprocess env contains only what was passed, including PATH and HOME", async () => {
  const cli = makeFakeCli();
  const manager = makeManager(cli);
  const session = manager.sessionFor("ctx-env");
  collect(session);
  await session.send(userMessage("hi", "u1"));
  await until(() => cli.processes.length === 1, "spawned");

  const env = cli.processes[0]?.options.env;
  assert.ok(env, "env explicitly set (SDK replaces, not merges)");
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LOGNAME", "PATH", "USER"]);
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.HOME, process.env.HOME);
  assert.equal(cli.processes[0]?.options.cwd, "/home/hearth");
  await manager.shutdown();
});

test("SIGTERM to the host terminates all pooled subprocesses", async () => {
  const cli = makeFakeCli();
  const manager = makeManager(cli);
  const fakeHost = new EventEmitter() as unknown as NodeJS.Process;
  manager.installSignalHandlers(fakeHost);

  const a = manager.sessionFor("ctx-s1");
  const b = manager.sessionFor("ctx-s2");
  const framesA = collect(a);
  const framesB = collect(b);
  await a.send(userMessage("a", "ua"));
  await b.send(userMessage("b", "ub"));
  await until(() => results(framesA).length === 1 && results(framesB).length === 1, "both settled");
  assert.equal(manager.hotCount, 2);

  (fakeHost as unknown as EventEmitter).emit("SIGTERM");
  await until(() => cli.processes.every((p) => p.ended), "all subprocesses ended");
  assert.equal(cli.processes.length, 2);
  assert.ok(cli.processes.every((p) => p.aborted || p.ended));
  await until(() => manager.hotCount === 0, "pool drained");
});

test("a crash mid-turn injects a failure result and the session recovers", async () => {
  const cli = makeFakeCli();
  cli.hold = true;
  const manager = makeManager(cli);
  const session = manager.sessionFor("ctx-crash");
  const frames = collect(session);

  await session.send(userMessage("doomed", "u1"));
  await until(() => cli.processes[0]?.received.length === 1, "delivered");
  // Kill the subprocess out from under the manager.
  cli.processes[0]?.options.abortController?.abort();
  await until(() => results(frames).length === 1, "synthetic failure result");
  const failure = results(frames)[0] as { subtype: string; errors: string[] };
  assert.equal(failure.subtype, "error_during_execution");
  assert.match(failure.errors.join(" "), /exited|crashed/);

  // Next send cold-starts a fresh generation on the same id.
  cli.hold = false;
  await session.send(userMessage("are you back?", "u2"));
  await until(() => results(frames).length === 2, "recovered");
  assert.equal(cli.processes.length, 2);
  await manager.shutdown();
});

test("each generation gets its own MCP server instance, plus the allow-list", async () => {
  const cli = makeFakeCli();
  let built = 0;
  const makeToolbelt = () =>
    ({ type: "sdk", name: "thicket", id: (built += 1) }) as unknown as NonNullable<
      Options["mcpServers"]
    >[string];
  const manager = makeManager(cli, {
    mcpServers: () => ({ thicket: makeToolbelt() }),
    allowedTools: ["mcp__thicket__post_message"],
  });
  const one = manager.sessionFor("ctx-mcp-1");
  const two = manager.sessionFor("ctx-mcp-2");
  collect(one);
  collect(two);
  await one.send(userMessage("hi", "u1"));
  await two.send(userMessage("hi", "u2"));
  await until(() => cli.processes.length === 2, "both spawned");
  const [a, b] = cli.processes;
  assert.ok(a?.options.mcpServers?.thicket);
  assert.ok(b?.options.mcpServers?.thicket);
  assert.notEqual(
    a.options.mcpServers.thicket,
    b.options.mcpServers.thicket,
    "an MCP server instance serves one session; sharing one breaks the second connect",
  );
  assert.deepEqual(a.options.allowedTools, ["mcp__thicket__post_message"]);
  await manager.shutdown();
});

test("harness permissionMode reaches the query options", async () => {
  const cli = makeFakeCli();
  const manager = makeManager(cli, {
    harness: { cwd: "/home/hearth", model: "claude-opus-5", sessionTtlSeconds: TTL_S, permissionMode: "auto" },
  });
  const session = manager.sessionFor("ctx-perm");
  collect(session);
  await session.send(userMessage("hi", "u1"));
  await until(() => cli.processes.length === 1, "spawned");
  assert.equal(cli.processes[0]?.options.permissionMode, "auto");
  await manager.shutdown();
});
