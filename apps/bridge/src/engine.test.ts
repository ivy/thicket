import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskState } from "@a2a-js/sdk";
import type { Message, Task } from "@a2a-js/sdk";
import { deriveSessionId } from "@thicket/executor";

import { BridgeEngine } from "./engine.js";
import { BridgeState } from "./state.js";
import {
  META_QUEUED_TURN_COUNT,
  META_SHOULD_QUERY,
  type A2AEvent,
  type AgentClient,
  type SlackApi,
  type SlackSessionStatus,
} from "./types.js";

type SlackCall =
  | { type: "setStatus"; channel: string; threadTs: string; status: SlackSessionStatus }
  | { type: "post"; channel: string; threadTs: string; text: string }
  | { type: "startStream"; channel: string; threadTs: string; ts: string }
  | { type: "append"; channel: string; ts: string; text: string }
  | { type: "stop"; channel: string; ts: string };

class FakeSlack implements SlackApi {
  calls: SlackCall[] = [];
  private streamCounter = 0;

  async setStatus(channel: string, threadTs: string, status: SlackSessionStatus) {
    this.calls.push({ type: "setStatus", channel, threadTs, status });
  }
  async postMessage(channel: string, threadTs: string, text: string) {
    this.calls.push({ type: "post", channel, threadTs, text });
  }
  async startStream(channel: string, threadTs: string) {
    const ts = `stream-${++this.streamCounter}`;
    this.calls.push({ type: "startStream", channel, threadTs, ts });
    return ts;
  }
  async appendStream(channel: string, ts: string, text: string) {
    this.calls.push({ type: "append", channel, ts, text });
  }
  async stopStream(channel: string, ts: string) {
    this.calls.push({ type: "stop", channel, ts });
  }

  statuses(): SlackSessionStatus[] {
    return this.calls.filter((c) => c.type === "setStatus").map((c) => c.status);
  }
  lastStatus(): SlackSessionStatus | undefined {
    return this.statuses().at(-1);
  }
  posts(): string[] {
    return this.calls.filter((c) => c.type === "post").map((c) => c.text);
  }
}

interface StubBehavior {
  streaming?: boolean;
  /** Events yielded per streamed turn, given the sent message. */
  script?: (message: Message, turn: number) => A2AEvent[];
  /** Blocking result for non-streaming agents. */
  blockingResult?: (message: Message) => Task;
  reachable?: boolean;
  /** Events yielded on resubscribe. */
  resubscribeScript?: (taskId: string) => A2AEvent[];
  /** Gate each stream on manual release (for serialization tests). */
  gated?: boolean;
}

class StubClient implements AgentClient {
  sent: Message[] = [];
  streamed: Message[] = [];
  cancels: string[] = [];
  resubscribes: string[] = [];
  streamStarts = 0;
  private gates: (() => void)[] = [];
  private turn = 0;

  constructor(public behavior: StubBehavior) {}

  releaseOne(): void {
    this.gates.shift()?.();
  }

  async fetchCard() {
    if (this.behavior.reachable === false) {
      throw new Error("ECONNREFUSED: machine asleep");
    }
    return { streaming: this.behavior.streaming ?? true };
  }

  stream(message: Message): AsyncIterable<A2AEvent> {
    this.streamed.push(message);
    this.streamStarts += 1;
    const gate = this.behavior.gated
      ? new Promise<void>((resolve) => this.gates.push(resolve))
      : undefined;
    const events = this.behavior.script?.(message, this.turn++) ?? [];
    return (async function* () {
      if (gate !== undefined) {
        await gate;
      }
      for (const event of events) {
        yield event;
      }
    })();
  }

  async send(message: Message): Promise<Task> {
    if (this.behavior.reachable === false) {
      throw new Error("ECONNREFUSED: machine asleep");
    }
    this.sent.push(message);
    const make = this.behavior.blockingResult;
    if (make === undefined) {
      // Context-only sends ignore the result; a minimal task suffices.
      return {
        id: "ambient",
        contextId: message.contextId,
        status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: "t" },
        artifacts: [],
        history: [],
        metadata: {},
      };
    }
    return make(message);
  }

  async cancel(taskId: string): Promise<void> {
    this.cancels.push(taskId);
  }

  resubscribe(taskId: string): AsyncIterable<A2AEvent> {
    this.resubscribes.push(taskId);
    const events = this.behavior.resubscribeScript?.(taskId) ?? [];
    return (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
  }
}

function taskEvent(taskId: string, contextId: string, state = TaskState.TASK_STATE_WORKING): A2AEvent {
  return {
    kind: "task",
    task: {
      id: taskId,
      contextId,
      status: { state, message: undefined, timestamp: "t" },
      artifacts: [],
      history: [],
      metadata: {},
    },
  };
}

function statusEvent(
  taskId: string,
  state: TaskState,
  extra: { messageText?: string; queued?: number } = {},
): A2AEvent {
  return {
    kind: "status",
    taskId,
    contextId: "ctx",
    state,
    messageText: extra.messageText,
    metadata: extra.queued === undefined ? {} : { [META_QUEUED_TURN_COUNT]: extra.queued },
  };
}

function artifactEvent(taskId: string, text: string, append: boolean, lastChunk: boolean): A2AEvent {
  return { kind: "artifact", taskId, text, append, lastChunk };
}

interface Rig {
  engine: BridgeEngine;
  slack: FakeSlack;
  client: StubClient;
  state: BridgeState;
}

function rig(behavior: StubBehavior, options: { queueing?: "harness" | "bridge"; dbPath?: string } = {}): Rig {
  const slack = new FakeSlack();
  const client = new StubClient(behavior);
  const state = new BridgeState(options.dbPath ?? ":memory:");
  const engine = new BridgeEngine({
    agent: "hearth",
    queueing: options.queueing ?? "harness",
    client,
    slack,
    state,
  });
  return { engine, slack, client, state };
}

const CH = "C123";
const TH = "1724650000.000100";

function dm(text: string, ts = "1724650001.000001") {
  return { kind: "dm" as const, channel: CH, threadTs: TH, text, messageTs: ts };
}

// ---------------------------------------------------------------- status map

const STATUS_TABLE: [TaskState, SlackSessionStatus][] = [
  [TaskState.TASK_STATE_SUBMITTED, "processing"],
  [TaskState.TASK_STATE_WORKING, "processing"],
  [TaskState.TASK_STATE_COMPLETED, "active"],
  [TaskState.TASK_STATE_INPUT_REQUIRED, "active"],
  [TaskState.TASK_STATE_AUTH_REQUIRED, "suspended"],
  [TaskState.TASK_STATE_FAILED, "active"],
  [TaskState.TASK_STATE_REJECTED, "active"],
  [TaskState.TASK_STATE_CANCELED, "active"],
];

for (const [state, expected] of STATUS_TABLE) {
  test(`status mapping: ${TaskState[state]} -> ${expected}`, async () => {
    const r = rig({
      script: () => [taskEvent("t1", "ctx"), statusEvent("t1", state)],
    });
    await r.engine.handleEvent(dm("hello"));
    assert.equal(r.slack.lastStatus(), expected);
    if (state === TaskState.TASK_STATE_AUTH_REQUIRED) {
      assert.ok(
        r.slack.posts().some((p) => /authentication/i.test(p)),
        "auth-required posts an auth notice in-thread",
      );
    }
    if (state === TaskState.TASK_STATE_FAILED || state === TaskState.TASK_STATE_REJECTED) {
      assert.ok(
        r.slack.posts().length > 0,
        "failed/rejected posts an error message in-thread",
      );
    }
    r.state.close();
  });
}

test("terminal with queued_turn_count > 0 holds processing; 0 releases to active", async () => {
  const held = rig({
    script: () => [
      taskEvent("t1", "ctx"),
      statusEvent("t1", TaskState.TASK_STATE_COMPLETED, { queued: 2 }),
    ],
  });
  await held.engine.handleEvent(dm("first"));
  assert.equal(held.slack.lastStatus(), "processing");
  held.state.close();

  const released = rig({
    script: () => [
      taskEvent("t1", "ctx"),
      statusEvent("t1", TaskState.TASK_STATE_COMPLETED, { queued: 0 }),
    ],
  });
  await released.engine.handleEvent(dm("first"));
  assert.equal(released.slack.lastStatus(), "active");
  released.state.close();
});

// ---------------------------------------------------------------- streaming

test("streaming: one startStream, N appends, one stopStream, exact concatenation", async () => {
  const r = rig({
    script: (m) => [
      taskEvent("t1", m.contextId),
      artifactEvent("t1", "The tide ", false, false),
      artifactEvent("t1", "comes in ", true, false),
      artifactEvent("t1", "at 6pm.", true, true),
      statusEvent("t1", TaskState.TASK_STATE_COMPLETED),
    ],
  });
  await r.engine.handleEvent(dm("when is the tide?"));

  const starts = r.slack.calls.filter((c) => c.type === "startStream");
  const appends = r.slack.calls.filter((c) => c.type === "append");
  const stops = r.slack.calls.filter((c) => c.type === "stop");
  assert.equal(starts.length, 1);
  assert.equal(appends.length, 3);
  assert.equal(stops.length, 1);
  assert.equal(appends.map((a) => a.text).join(""), "The tide comes in at 6pm.");
  assert.ok(
    appends.every((a) => a.ts === starts[0]!.ts),
    "appends target the started stream",
  );
  r.state.close();
});

test("non-streaming agent: one postMessage, no stream calls", async () => {
  const r = rig({
    streaming: false,
    blockingResult: (m) => ({
      id: "t1",
      contextId: m.contextId,
      status: {
        state: TaskState.TASK_STATE_COMPLETED,
        message: {
          messageId: "reply",
          contextId: m.contextId,
          taskId: "t1",
          role: 2,
          parts: [
            {
              content: { $case: "text", value: "the answer" },
              mediaType: "text/plain",
              filename: "",
              metadata: {},
            },
          ],
          metadata: {},
          extensions: [],
          referenceTaskIds: [],
        },
        timestamp: "t",
      },
      artifacts: [],
      history: [],
      metadata: {},
    }),
  });
  await r.engine.handleEvent(dm("question"));
  assert.equal(r.slack.posts().length, 1);
  assert.equal(r.slack.posts()[0], "the answer");
  assert.equal(r.slack.calls.filter((c) => c.type === "startStream").length, 0);
  assert.equal(r.slack.calls.filter((c) => c.type === "append").length, 0);
  assert.equal(r.slack.calls.filter((c) => c.type === "stop").length, 0);
  r.state.close();
});

// ------------------------------------------------------------- stop button

test("agent_session_stopped cancels the in-flight task on that thread", async () => {
  const r = rig({});
  r.state.recordTask({ taskId: "t-live", agent: "hearth", channel: CH, threadTs: TH, streamTs: null });
  await r.engine.handleEvent({ kind: "session_stopped", channel: CH, threadTs: TH });
  assert.deepEqual(r.client.cancels, ["t-live"]);
  r.state.close();
});

// ------------------------------------------------- context-only messages

test("non-mention message in an engaged thread: shouldQuery false, no turn", async () => {
  const r = rig({
    script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)],
  });
  // Engage the thread first.
  await r.engine.handleEvent(dm("hello"));
  const before = r.slack.calls.length;

  await r.engine.handleEvent({
    kind: "thread_message",
    channel: CH,
    threadTs: TH,
    text: "fyi the deploy window is Friday",
    messageTs: "1724650002.000001",
  });

  assert.equal(r.client.sent.length, 1, "delivered via blocking send");
  assert.equal(r.client.sent[0]?.metadata?.[META_SHOULD_QUERY], false);
  assert.equal(r.client.streamed.length, 1, "no second turn streamed");
  assert.equal(r.slack.calls.length, before, "no status change, no reply");
  r.state.close();
});

test("thread message in a non-engaged thread is ignored", async () => {
  const r = rig({});
  await r.engine.handleEvent({
    kind: "thread_message",
    channel: CH,
    threadTs: "9999.0001",
    text: "unrelated chatter",
    messageTs: "9999.0002",
  });
  assert.equal(r.client.sent.length, 0);
  assert.equal(r.slack.calls.length, 0);
  r.state.close();
});

// ---------------------------------------------------------------- queueing

test("queueing: bridge serializes; harness sends without waiting", async () => {
  const serialized = rig(
    { gated: true, script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)] },
    { queueing: "bridge" },
  );
  const p1 = serialized.engine.handleEvent(dm("one", "1.1"));
  const p2 = serialized.engine.handleEvent(dm("two", "1.2"));
  await new Promise((r_) => setImmediate(r_));
  assert.equal(serialized.client.streamStarts, 1, "second turn waits");
  serialized.client.releaseOne();
  await p1;
  await new Promise((r_) => setImmediate(r_));
  assert.equal(serialized.client.streamStarts, 2, "second turn follows the first");
  serialized.client.releaseOne();
  await p2;
  serialized.state.close();

  const concurrent = rig(
    { gated: true, script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)] },
    { queueing: "harness" },
  );
  const q1 = concurrent.engine.handleEvent(dm("one", "1.1"));
  const q2 = concurrent.engine.handleEvent(dm("two", "1.2"));
  await new Promise((r_) => setImmediate(r_));
  assert.equal(concurrent.client.streamStarts, 2, "both sent without waiting");
  concurrent.client.releaseOne();
  concurrent.client.releaseOne();
  await Promise.all([q1, q2]);
  concurrent.state.close();
});

// ------------------------------------------------------------- context ids

test("agent-minted contextId is recorded and used from then on", async () => {
  const derived = deriveSessionId(CH, TH);
  const r = rig({
    script: (m, turn) => [
      taskEvent("t" + turn, turn === 0 ? "agent-minted-ctx" : m.contextId),
      statusEvent("t" + turn, TaskState.TASK_STATE_COMPLETED),
    ],
  });
  await r.engine.handleEvent(dm("first"));
  assert.equal(r.client.streamed[0]?.contextId, derived, "first send proposes the derivation");
  assert.equal(r.state.contextFor(CH, TH), "agent-minted-ctx", "mismatch persisted");

  await r.engine.handleEvent(dm("second", "1724650003.000001"));
  assert.equal(r.client.streamed[1]?.contextId, "agent-minted-ctx", "agent's value wins");
  r.state.close();
});

// ------------------------------------------------------------ unreachable

test("unreachable agent: in-thread notice, queued, delivered on recovery", async () => {
  const r = rig({
    reachable: false,
    script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)],
  });
  await r.engine.handleEvent(dm("are you there?"));
  assert.ok(
    r.slack.posts().some((p) => /unreachable|asleep/i.test(p)),
    "clear in-thread notice",
  );
  assert.equal(r.state.queuedFor("hearth").length, 1, "request queued");
  assert.equal(r.client.streamStarts, 0);

  // Machine wakes up.
  r.client.behavior.reachable = true;
  const delivered = await r.engine.flushQueue();
  assert.equal(delivered, 1);
  assert.equal(r.client.streamStarts, 1, "queued request delivered");
  assert.equal(r.client.streamed[0]?.parts[0]?.content?.$case, "text");
  assert.equal(r.state.queuedFor("hearth").length, 0);
  r.state.close();
});

// ------------------------------------------------------------------ restart

test("bridge restart routes an in-flight task's completion to its thread", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "bridge.db");

  // First process records the in-flight task, then dies.
  const first = new BridgeState(dbPath);
  first.recordTask({ taskId: "t-orphan", agent: "hearth", channel: CH, threadTs: TH, streamTs: null });
  first.close();

  // Second process resubscribes on start and lands events in the thread.
  const r = rig(
    {
      resubscribeScript: () => [
        artifactEvent("t-orphan", "late ", false, false),
        artifactEvent("t-orphan", "answer", true, true),
        statusEvent("t-orphan", TaskState.TASK_STATE_COMPLETED),
      ],
    },
    { dbPath },
  );
  await r.engine.start();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(r.client.resubscribes, ["t-orphan"]);
  const starts = r.slack.calls.filter((c) => c.type === "startStream");
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.channel, CH);
  assert.equal(starts[0]!.threadTs, TH);
  const appends = r.slack.calls.filter((c) => c.type === "append");
  assert.equal(appends.map((a) => a.text).join(""), "late answer");
  assert.equal(r.slack.lastStatus(), "active");
  r.state.close();
});
