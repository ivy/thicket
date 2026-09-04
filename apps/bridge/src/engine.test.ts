import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskState } from "@a2a-js/sdk";
import type { Message, Task } from "@a2a-js/sdk";
import { deriveSessionId } from "@thicket/executor";

import { BridgeEngine, sessionTitle } from "./engine.js";
import { BridgeState } from "./state.js";
import {
  META_QUEUED_TURN_COUNT,
  META_QUESTIONS,
  META_SHOULD_QUERY,
  META_SLACK_CHANNEL,
  META_SLACK_THREAD,
  META_WORKSPACE,
  type A2AEvent,
  type AgentActivity,
  type AgentClient,
  type SlackApi,
  type SlackSessionStatus,
} from "./types.js";

type SlackCall =
  | {
      type: "setStatus";
      channel: string;
      threadTs: string;
      status: SlackSessionStatus;
      title?: string;
    }
  | { type: "note"; channel: string; threadTs: string; status: string }
  | { type: "post"; channel: string; threadTs: string; text: string }
  | { type: "postBlocks"; channel: string; threadTs: string; text: string; blocks: unknown[]; ts: string }
  | { type: "update"; channel: string; ts: string; text: string; blocks: unknown[] }
  | { type: "startStream"; channel: string; threadTs: string; ts: string }
  | { type: "append"; channel: string; ts: string; text: string }
  | { type: "activity"; channel: string; ts: string; activity: AgentActivity }
  | { type: "stop"; channel: string; ts: string };

class FakeSlack implements SlackApi {
  calls: SlackCall[] = [];
  /** When set, appendActivity rejects with it. */
  activityError: Error | undefined;
  private streamCounter = 0;

  async setStatus(
    channel: string,
    threadTs: string,
    status: SlackSessionStatus,
    options?: { title?: string },
  ) {
    this.calls.push({ type: "setStatus", channel, threadTs, status, title: options?.title });
  }
  /** Ids the fake should call bots; everything else is a person. */
  bots = new Set<string>();
  async isBotUser(userId: string) {
    return this.bots.has(userId);
  }
  async setThreadStatus(channel: string, threadTs: string, status: string) {
    this.calls.push({ type: "note", channel, threadTs, status });
  }
  async postMessage(channel: string, threadTs: string, text: string) {
    this.calls.push({ type: "post", channel, threadTs, text });
  }
  /** When set, postBlocks rejects with it (a surface refusing blocks). */
  blocksError: Error | undefined;
  private blocksCounter = 0;
  async postBlocks(channel: string, threadTs: string, text: string, blocks: unknown[]) {
    if (this.blocksError !== undefined) {
      throw this.blocksError;
    }
    const ts = `blocks-${++this.blocksCounter}`;
    this.calls.push({ type: "postBlocks", channel, threadTs, text, blocks, ts });
    return ts;
  }
  updateError: Error | undefined;
  async updateMessage(channel: string, ts: string, text: string, blocks: unknown[]) {
    if (this.updateError !== undefined) {
      throw this.updateError;
    }
    this.calls.push({ type: "update", channel, ts, text, blocks });
  }
  /** When set, startStream rejects with it (a channel refusing a stream). */
  startStreamError: Error | undefined;
  /** Recipients passed to startStream, in call order. */
  streamRecipients: (string | undefined)[] = [];
  async startStream(channel: string, threadTs: string, recipient?: string) {
    if (this.startStreamError !== undefined) {
      throw this.startStreamError;
    }
    this.streamRecipients.push(recipient);
    const ts = `stream-${++this.streamCounter}`;
    this.calls.push({ type: "startStream", channel, threadTs, ts });
    return ts;
  }
  /** When set, appendStream rejects with it (a message Slack has ended). */
  appendError: Error | undefined;
  async appendStream(channel: string, ts: string, text: string) {
    if (this.appendError !== undefined) {
      throw this.appendError;
    }
    this.calls.push({ type: "append", channel, ts, text });
  }
  async appendActivity(channel: string, ts: string, activity: AgentActivity) {
    if (this.activityError !== undefined) {
      throw this.activityError;
    }
    this.calls.push({ type: "activity", channel, ts, activity });
  }
  /** When set, stopStream rejects with it (nothing left to stop). */
  stopError: Error | undefined;
  async stopStream(channel: string, ts: string) {
    if (this.stopError !== undefined) {
      throw this.stopError;
    }
    this.calls.push({ type: "stop", channel, ts });
  }
  /** Reactions the bridge added; when reactionError is set, adds reject. */
  reactions: { channel: string; ts: string; emoji: string }[] = [];
  reactionError: Error | undefined;
  async addReaction(channel: string, ts: string, emoji: string) {
    if (this.reactionError !== undefined) {
      throw this.reactionError;
    }
    this.reactions.push({ channel, ts, emoji });
  }
  /** Channel names conversations.info would report; lookups counted. */
  channelNames = new Map<string, string>();
  channelNameError: Error | undefined;
  channelNameLookups = 0;
  async channelName(channel: string) {
    this.channelNameLookups += 1;
    if (this.channelNameError !== undefined) {
      throw this.channelNameError;
    }
    return this.channelNames.get(channel);
  }
  /** Thread transcript served to replay agents; keyed `channel:threadTs`. */
  threads = new Map<string, { ts: string; authorId?: string; botId?: string; text: string }[]>();
  repliesError: Error | undefined;
  async replies(channel: string, threadTs: string) {
    if (this.repliesError !== undefined) {
      throw this.repliesError;
    }
    return this.threads.get(`${channel}:${threadTs}`) ?? [];
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

function activityEvent(taskId: string, ...activities: AgentActivity[]): A2AEvent {
  return { kind: "activity", taskId, activities };
}

interface Rig {
  engine: BridgeEngine;
  slack: FakeSlack;
  client: StubClient;
  state: BridgeState;
  warnings: string[];
}

function rig(
  behavior: StubBehavior,
  options: {
    queueing?: "harness" | "bridge";
    context?: "native" | "replay";
    dbPath?: string;
    fileBaseUrl?: string;
    streamTextBudget?: number;
    bindings?: Record<string, string>;
  } = {},
): Rig {
  const slack = new FakeSlack();
  const client = new StubClient(behavior);
  const state = new BridgeState(options.dbPath ?? ":memory:");
  const warnings: string[] = [];
  const engine = new BridgeEngine({
    agent: "hearth",
    queueing: options.queueing ?? "harness",
    ...(options.context === undefined ? {} : { context: options.context }),
    ...(options.bindings === undefined ? {} : { bindings: options.bindings }),
    client,
    slack,
    state,
    logger: { info: () => {}, warn: (msg) => warnings.push(msg) },
    ...(options.fileBaseUrl === undefined ? {} : { fileBaseUrl: options.fileBaseUrl }),
    ...(options.streamTextBudget === undefined
      ? {}
      : { streamTextBudget: options.streamTextBudget }),
  });
  return { engine, slack, client, state, warnings };
}

const HUMAN = "U-human";
const CH = "C123";
const TH = "1724650000.000100";

function dm(text: string, ts = "1724650001.000001") {
  return {
    kind: "dm" as const,
    channel: CH,
    threadTs: TH,
    text,
    messageTs: ts,
    files: [],
    authorId: HUMAN,
    viaApp: false,
  };
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

// ---------------------------------------------------------------- activity

const CARD_RUNNING: AgentActivity = {
  id: "toolu_1",
  title: "Checking memory pressure",
  status: "running",
  details: "vm_stat",
};
const CARD_DONE: AgentActivity = { ...CARD_RUNNING, status: "done", details: undefined };

test("activity opens the stream before any text and updates the card in place", async () => {
  const r = rig({
    script: () => [
      taskEvent("t1", "ctx"),
      activityEvent("t1", CARD_RUNNING),
      activityEvent("t1", CARD_DONE),
      artifactEvent("t1", "Memory looks fine.", false, true),
      statusEvent("t1", TaskState.TASK_STATE_COMPLETED),
    ],
  });
  await r.engine.handleEvent(dm("how's memory?"));

  const kinds = r.slack.calls.map((c) => c.type);
  assert.deepEqual(kinds, [
    "setStatus", // processing, on the way out
    "note", // is thinking…
    "setStatus", // processing, from the task's working state
    "startStream",
    "activity", // card opens
    "note", // and the prose line follows it
    "activity", // card closes
    "note", // back to thinking: the card's send cleared the line
    "append",
    "stop",
    "note", // cleared
    "setStatus", // active
  ]);
  assert.deepEqual(
    r.slack.calls.filter((c) => c.type === "note").map((c) => c.status),
    ["is thinking…", "Checking memory pressure…", "is thinking…", ""],
  );
  const cards = r.slack.calls.filter((c) => c.type === "activity");
  assert.deepEqual(
    cards.map((c) => [c.activity.id, c.activity.status]),
    [
      ["toolu_1", "running"],
      ["toolu_1", "done"],
    ],
  );
  const started = r.slack.calls.find((c) => c.type === "startStream")!;
  assert.ok(
    cards.every((c) => c.ts === started.ts),
    "cards land on the thread's stream",
  );
  r.state.close();
});

test("the status line survives a gap between tool calls, and parallel steps", async () => {
  const one: AgentActivity = { id: "toolu_1", title: "Reading a file", status: "running" };
  const two: AgentActivity = { id: "toolu_2", title: "Running a command", status: "running" };
  const r = rig({
    script: () => [
      taskEvent("t1", "ctx"),
      activityEvent("t1", one, two),
      // The first of the pair closes while the second is still running:
      // the glance belongs to what is still open, not to thinking.
      activityEvent("t1", { ...one, status: "done" }),
      activityEvent("t1", { ...two, status: "done" }),
      artifactEvent("t1", "Done.", false, true),
      statusEvent("t1", TaskState.TASK_STATE_COMPLETED),
    ],
  });
  await r.engine.handleEvent(dm("look at both"));

  assert.deepEqual(
    r.slack.calls.filter((c) => c.type === "note").map((c) => c.status),
    [
      "is thinking…",
      "Reading a file…",
      "Running a command…",
      "Running a command…", // one closed, two still open
      "is thinking…", // both closed: the gap the model spends thinking
      "", // the turn ends
    ],
  );
  r.state.close();
});

test("a rejected card is abandoned for the task; the reply still lands", async () => {
  const r = rig({
    script: () => [
      taskEvent("t1", "ctx"),
      activityEvent("t1", CARD_RUNNING),
      activityEvent("t1", CARD_DONE),
      artifactEvent("t1", "Memory looks fine.", false, true),
      statusEvent("t1", TaskState.TASK_STATE_COMPLETED),
    ],
  });
  r.slack.activityError = new Error("invalid_chunk");
  await r.engine.handleEvent(dm("how's memory?"));

  assert.equal(r.slack.calls.filter((c) => c.type === "activity").length, 0);
  assert.equal(
    r.slack.calls.filter((c) => c.type === "append").map((c) => c.text).join(""),
    "Memory looks fine.",
  );
  assert.equal(r.slack.lastStatus(), "active");
  assert.equal(r.warnings.length, 1, "one warning, not one per card");
  r.state.close();
});

test("a turn ending on a tool call still closes its stream", async () => {
  const r = rig({
    script: () => [
      taskEvent("t1", "ctx"),
      activityEvent("t1", CARD_RUNNING, CARD_DONE),
      // No text artifact at all: nothing ever reports lastChunk.
      statusEvent("t1", TaskState.TASK_STATE_COMPLETED),
    ],
  });
  await r.engine.handleEvent(dm("just run it"));

  assert.equal(r.slack.calls.filter((c) => c.type === "startStream").length, 1);
  assert.equal(r.slack.calls.filter((c) => c.type === "stop").length, 1);
  assert.equal(r.slack.lastStatus(), "active");
  r.state.close();
});

test("a stream closed by lastChunk is not closed twice", async () => {
  const r = rig({
    script: () => [
      taskEvent("t1", "ctx"),
      artifactEvent("t1", "done", false, true),
      statusEvent("t1", TaskState.TASK_STATE_COMPLETED),
    ],
  });
  await r.engine.handleEvent(dm("hello"));
  assert.equal(r.slack.calls.filter((c) => c.type === "stop").length, 1);
  r.state.close();
});

// ------------------------------------------------------------ session title

test("the thread's first message titles the session; later turns do not", async () => {
  const r = rig({
    script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)],
  });
  await r.engine.handleEvent(dm("how is this machine doing?"));
  await r.engine.handleEvent(dm("and the disk?", "1724650009.000001"));

  const titles = r.slack.calls
    .filter((c) => c.type === "setStatus")
    .map((c) => c.title)
    .filter((t) => t !== undefined);
  assert.deepEqual(titles, ["how is this machine doing?"]);
  r.state.close();
});

test("session titles are flattened and clipped to Slack's limit", () => {
  assert.equal(sessionTitle("  hello\n  there  "), "hello there");
  assert.equal(sessionTitle("   "), undefined);
  const long = sessionTitle("x".repeat(500))!;
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…"));
});

// -------------------------------------------------------------- loop guard

test("an agent's own post is ignored; a human's via an app is not", async () => {
  const r = rig({
    script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)],
  });
  const BOT = "U-hearth-bot";
  r.slack.bots.add(BOT);

  // The agent's own reply: carries a bot_id *and* its bot user as author.
  await r.engine.handleEvent({ ...dm("my own reply"), authorId: BOT, viaApp: true });
  assert.equal(r.client.streamStarts, 0, "an agent must never answer itself");

  // A human through an MCP tool: same bot_id stamp, human author.
  await r.engine.handleEvent({ ...dm("from a test harness"), viaApp: true });
  assert.equal(r.client.streamStarts, 1, "a person posting through an app is still a person");
  r.state.close();
});

test("an unresolvable author fails closed", async () => {
  const r = rig({
    script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)],
  });
  r.slack.isBotUser = async () => {
    throw new Error("ratelimited");
  };
  await r.engine.handleEvent({ ...dm("who sent this?"), viaApp: true });
  assert.equal(r.client.streamStarts, 0, "silence beats an agent talking to itself");
  assert.equal(r.warnings.length, 1);
  r.state.close();
});

test("a plain human message costs no lookup at all", async () => {
  const r = rig({
    script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)],
  });
  let asked = 0;
  r.slack.isBotUser = async () => {
    asked += 1;
    return false;
  };
  await r.engine.handleEvent(dm("hello"));
  assert.equal(asked, 0, "no bot_id, no question to ask");
  assert.equal(r.client.streamStarts, 1);
  r.state.close();
});

// ------------------------------------------------------------- attachments

const UPLOAD = {
  id: "F1",
  name: "quarterly.csv",
  mimetype: "text/csv",
  size: 2048,
  downloadUrl: "https://files.slack.com/download/F1",
};

function dmWithFile(text = "what do you make of this?") {
  return { ...dm(text), files: [UPLOAD] };
}

test("an upload is recorded and referred to by url, never by bytes", async () => {
  const r = rig(
    { script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)] },
    { fileBaseUrl: "https://thicket-bridge.example.ts.net/" },
  );
  await r.engine.handleEvent(dmWithFile());

  const recorded = r.state.fileFor("hearth", "F1");
  assert.equal(recorded?.url, UPLOAD.downloadUrl, "the private URL stays bridge-side");
  assert.equal(recorded?.threadTs, TH);

  const parts = r.client.streamed[0]?.parts ?? [];
  assert.deepEqual(
    parts.map((p) => p.content?.$case),
    ["text", "url"],
    "text plus one reference; no raw bytes",
  );
  const file = parts[1]!;
  assert.equal(
    file.content?.$case === "url" ? file.content.value : "",
    // The trailing slash on the configured base must not double up.
    "https://thicket-bridge.example.ts.net/files/F1",
  );
  assert.equal(file.filename, "quarterly.csv");
  assert.equal(file.mediaType, "text/csv");
  assert.equal(file.metadata?.["thicket.fileSize"], 2048);
  r.state.close();
});

test("with no reachable address, attachments are declined in the thread", async () => {
  const r = rig({
    script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)],
  });
  await r.engine.handleEvent(dmWithFile("read this"));

  assert.ok(
    r.slack.posts().some((p) => /can't read attachments/i.test(p)),
    "the user is told, rather than handed a dead link",
  );
  assert.equal(r.state.fileFor("hearth", "F1"), undefined);
  const parts = r.client.streamed[0]?.parts ?? [];
  assert.deepEqual(parts.map((p) => p.content?.$case), ["text"]);
  assert.equal(r.client.streamed.length, 1, "the turn still runs on the text");
  r.state.close();
});

test("an upload to an unreachable agent survives the queue", async () => {
  const r = rig(
    {
      reachable: false,
      script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)],
    },
    { fileBaseUrl: "https://thicket-bridge.example.ts.net" },
  );
  await r.engine.handleEvent(dmWithFile());
  assert.deepEqual(r.state.queuedFor("hearth")[0]?.fileIds, ["F1"]);

  r.client.behavior.reachable = true;
  await r.engine.flushQueue();
  const parts = r.client.streamed[0]?.parts ?? [];
  assert.deepEqual(
    parts.map((p) => p.content?.$case),
    ["text", "url"],
    "the attachment is still referred to after the wait",
  );
  r.state.close();
});

test("a context-only message carries its attachments too", async () => {
  const r = rig(
    { script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)] },
    { fileBaseUrl: "https://thicket-bridge.example.ts.net" },
  );
  await r.engine.handleEvent(dm("hello")); // engage the thread
  await r.engine.handleEvent({
    kind: "thread_message",
    channel: CH,
    threadTs: TH,
    text: "and here's the log",
    messageTs: "1724650005.000001",
    files: [{ ...UPLOAD, id: "F2" }],
    authorId: HUMAN,
    viaApp: false,
  });

  const parts = r.client.sent[0]?.parts ?? [];
  assert.deepEqual(parts.map((p) => p.content?.$case), ["text", "url"]);
  assert.equal(r.client.sent[0]?.metadata?.[META_SHOULD_QUERY], false);
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
    files: [],
    authorId: HUMAN,
    viaApp: false,
  });

  assert.equal(r.client.sent.length, 1, "delivered via blocking send");
  assert.equal(r.client.sent[0]?.metadata?.[META_SHOULD_QUERY], false);
  assert.equal(r.client.streamed.length, 1, "no second turn streamed");
  assert.equal(r.slack.calls.length, before, "no status change, no reply");
  r.state.close();
});

test("every message to the agent says which channel and thread it came from — ids only", async () => {
  const r = rig({
    script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)],
  });
  await r.engine.handleEvent(dm("where am I?"));
  await r.engine.handleEvent({
    kind: "thread_message",
    channel: CH,
    threadTs: TH,
    text: "fyi",
    messageTs: "1724650002.000001",
    files: [],
    authorId: HUMAN,
    viaApp: false,
  });
  for (const message of [r.client.streamed[0]!, r.client.sent[0]!]) {
    assert.equal(message.metadata?.[META_SLACK_CHANNEL], CH);
    assert.equal(message.metadata?.[META_SLACK_THREAD], TH);
    const values = Object.values(message.metadata ?? {}).map(String);
    assert.equal(values.some((v) => /where am I|fyi/.test(v)), false, "no content in metadata");
  }
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
    files: [],
    authorId: HUMAN,
    viaApp: false,
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

// ---------------------------------------------------------- context: replay

function textOf(message: Message | undefined): string {
  const part = message?.parts.find((p) => p.content?.$case === "text");
  return part?.content?.$case === "text" ? part.content.value : "";
}

test("a replay agent's turn carries the thread transcript, current message last", async () => {
  const r = rig(
    { script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)] },
    { context: "replay" },
  );
  r.slack.threads.set(`${CH}:${TH}`, [
    { ts: TH, authorId: HUMAN, text: "release notes are out" },
    { ts: "1724650000.000200", botId: "B1", text: "summarizing now" },
    { ts: "1724650001.000001", authorId: HUMAN, text: "what did I miss?" },
  ]);

  await r.engine.handleEvent(dm("what did I miss?"));

  const sent = textOf(r.client.streamed[0]);
  assert.match(sent, /Thread so far/);
  assert.match(sent, /\[U-human\] release notes are out/);
  assert.match(sent, /\[B1\] summarizing now/);
  assert.match(sent, /Current message:\nwhat did I miss\?$/);
  assert.equal(
    sent.match(/what did I miss\?/g)?.length,
    1,
    "the triggering message appears once, not also in the transcript",
  );
  r.state.close();
});

test("a native agent's turn is untouched by thread history", async () => {
  const r = rig({
    script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)],
  });
  r.slack.threads.set(`${CH}:${TH}`, [{ ts: TH, authorId: HUMAN, text: "earlier" }]);
  await r.engine.handleEvent(dm("hello"));
  assert.equal(textOf(r.client.streamed[0]), "hello");
  r.state.close();
});

test("an unavailable transcript degrades to the bare message, not a dead turn", async () => {
  const r = rig(
    { script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)] },
    { context: "replay" },
  );
  r.slack.repliesError = new Error("ratelimited");
  await r.engine.handleEvent(dm("still there?"));
  assert.equal(textOf(r.client.streamed[0]), "still there?");
  assert.ok(r.warnings.some((w) => w.includes("replay transcript unavailable")));
  r.state.close();
});

test("a replay agent gets no context-only pushes; the next turn re-reads the thread", async () => {
  const r = rig(
    { script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)] },
    { context: "replay" },
  );
  await r.engine.handleEvent(dm("hello"));
  await r.engine.handleEvent({
    kind: "thread_message",
    channel: CH,
    threadTs: TH,
    text: "fyi",
    messageTs: "1724650002.000001",
    files: [],
    authorId: HUMAN,
    viaApp: false,
  });
  assert.equal(r.client.sent.length, 0, "no shouldQuery:false push for a stateless harness");
  r.state.close();
});

// --------------------------------------------------------------- reactions

test("the message that opens a session gets eyes, later messages do not", async () => {
  const r = rig({
    script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)],
  });
  await r.engine.handleEvent(dm("hello", "1724650001.000001"));
  await r.engine.handleEvent(dm("and another", "1724650002.000001"));

  assert.deepEqual(r.slack.reactions, [
    { channel: CH, ts: "1724650001.000001", emoji: "eyes" },
  ]);
  r.state.close();
});

test("a failed opening reaction never fails the turn", async () => {
  const r = rig({
    script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)],
  });
  r.slack.reactionError = new Error("ratelimited");
  await r.engine.handleEvent(dm("hello"));

  assert.equal(r.client.streamed.length, 1, "the turn still ran");
  assert.equal(r.slack.lastStatus(), "active", "and completed normally");
  assert.ok(r.warnings.some((w) => w.includes("opening reaction failed")));
  r.state.close();
});


// ------------------------------------------------------- channel streaming

test("a channel turn's stream is addressed to the message's author", async () => {
  const r = rig({
    script: () => [
      taskEvent("t1", "ctx"),
      artifactEvent("t1", "here you go", false, true),
      statusEvent("t1", TaskState.TASK_STATE_COMPLETED),
    ],
  });
  await r.engine.handleEvent({
    kind: "mention",
    channel: CH,
    threadTs: TH,
    text: "@hearth summarize",
    messageTs: "1724650001.000001",
    files: [],
    authorId: HUMAN,
    viaApp: false,
  });
  assert.deepEqual(r.slack.streamRecipients, [HUMAN]);
  r.state.close();
});

test("a refused stream degrades to one plain message carrying the whole answer", async () => {
  const r = rig({
    script: () => [
      taskEvent("t1", "ctx"),
      artifactEvent("t1", "the answer ", false, false),
      artifactEvent("t1", "in two chunks", true, true),
      statusEvent("t1", TaskState.TASK_STATE_COMPLETED),
    ],
  });
  r.slack.startStreamError = new Error("An API error occurred: missing_recipient_team_id");
  await r.engine.handleEvent(dm("hello"));

  assert.deepEqual(r.slack.posts(), ["the answer in two chunks"]);
  assert.equal(r.slack.lastStatus(), "active", "the turn settled normally");
  assert.ok(r.warnings.some((w) => w.includes("stream refused")));
  r.state.close();
});

// ------------------------------------------------------- stream rollover

test("a long answer rolls over to fresh streamed messages at word boundaries", async () => {
  const r = rig(
    {
      script: () => [
        taskEvent("t1", "ctx"),
        artifactEvent("t1", "aaaa bbbb cccc dddd ", false, false),
        artifactEvent("t1", "eeee ffff gggg hhhh iiii jjjj", true, true),
        statusEvent("t1", TaskState.TASK_STATE_COMPLETED),
      ],
    },
    { streamTextBudget: 40 },
  );
  await r.engine.handleEvent(dm("write me something long"));

  const appendsByStream = new Map<string, string>();
  let stopsBeforeSecondStart = 0;
  let starts = 0;
  for (const call of r.slack.calls) {
    if (call.type === "startStream") {
      starts += 1;
    }
    if (call.type === "stop" && starts === 1) {
      stopsBeforeSecondStart += 1;
    }
    if (call.type === "append") {
      appendsByStream.set(call.ts, (appendsByStream.get(call.ts) ?? "") + call.text);
    }
  }
  assert.equal(starts, 2, "the answer spans two streamed messages");
  assert.equal(stopsBeforeSecondStart, 1, "the first message is closed before the second opens");
  const [first, second] = [...appendsByStream.values()];
  assert.equal(first, "aaaa bbbb cccc dddd eeee ffff gggg hhhh");
  assert.equal(second, "iiii jjjj");
  assert.equal(r.slack.lastStatus(), "active");
  r.state.close();
});

test("a code block spanning a rollover is closed and reopened", async () => {
  const block = "```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n```\n";
  const r = rig(
    {
      script: () => [
        taskEvent("t1", "ctx"),
        artifactEvent("t1", "Here it is:\n\n", false, false),
        artifactEvent("t1", block, true, true),
        statusEvent("t1", TaskState.TASK_STATE_COMPLETED),
      ],
    },
    { streamTextBudget: 40 },
  );
  await r.engine.handleEvent(dm("show me the code"));

  const byStream = new Map<string, string>();
  for (const call of r.slack.calls) {
    if (call.type === "append") {
      byStream.set(call.ts, (byStream.get(call.ts) ?? "") + call.text);
    }
  }
  const messages = [...byStream.values()];
  assert.ok(messages.length > 1, `the block spans several messages (got ${messages.length})`);
  for (const message of messages) {
    const fences = (message.match(/^```/gm) ?? []).length;
    assert.equal(fences % 2, 0, `each message closes what it opens: ${JSON.stringify(message)}`);
  }
  const code = messages.flatMap((m) => m.split("\n")).filter((l) => l.startsWith("const "));
  assert.deepEqual(code, ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;"]);
  assert.ok(
    messages.slice(1).every((m) => m.startsWith("```ts\n")),
    "every continuation reopens the block with its info string",
  );
  r.state.close();
});

test("a card that forces a rollover mid-block closes the block first", async () => {
  const r = rig(
    {
      script: () => [
        taskEvent("t1", "ctx"),
        artifactEvent("t1", "```ts\nconst a = 1;\n", false, false),
        // Charged against the same budget, and over it: the rollover here
        // is one no split point asked for.
        activityEvent("t1", { id: "a1", title: "Reading the file", status: "running" }),
        artifactEvent("t1", "const b = 2;\n```\n", true, true),
        statusEvent("t1", TaskState.TASK_STATE_COMPLETED),
      ],
    },
    { streamTextBudget: 60 },
  );
  await r.engine.handleEvent(dm("show me the code"));

  const byStream = new Map<string, string>();
  for (const call of r.slack.calls) {
    if (call.type === "append") {
      byStream.set(call.ts, (byStream.get(call.ts) ?? "") + call.text);
    }
  }
  const messages = [...byStream.values()];
  assert.equal(messages.length, 2, `two messages: ${JSON.stringify(messages)}`);
  assert.equal(messages[0], "```ts\nconst a = 1;\n```");
  assert.ok(messages[1]!.startsWith("```ts\nconst b = 2;"));
  r.state.close();
});

test("a stream Slack ends mid-answer costs the cards, not the turn", async () => {
  const r = rig({
    script: () => [
      taskEvent("t1", "ctx"),
      activityEvent("t1", { id: "a1", title: "Reading", status: "running" }),
      artifactEvent("t1", "the answer ", false, false),
      artifactEvent("t1", "in two chunks", true, true),
      statusEvent("t1", TaskState.TASK_STATE_COMPLETED),
    ],
  });
  // Slack ended the streamed message when it refused the first append, so
  // stopping it is refused too — the shape of a real msg_too_long turn.
  r.slack.appendError = new Error("An API error occurred: msg_too_long");
  r.slack.stopError = new Error("An API error occurred: message_not_in_streaming_state");
  await r.engine.handleEvent(dm("write me something long"));

  assert.deepEqual(r.slack.posts(), ["the answer in two chunks"], "the answer still arrives");
  assert.equal(r.slack.lastStatus(), "active", "the turn settles normally");
  assert.ok(
    !r.slack.posts().some((p) => /went wrong/i.test(p)),
    "a delivered answer is not reported as a failure",
  );
  assert.ok(r.warnings.some((w) => w.includes("stream refused")));
  r.state.close();
});

test("a stream that cannot be closed is still a finished turn", async () => {
  const r = rig({
    script: () => [
      taskEvent("t1", "ctx"),
      artifactEvent("t1", "the whole answer", true, true),
      statusEvent("t1", TaskState.TASK_STATE_COMPLETED),
    ],
  });
  // Slack ended the message on its own; the answer had already streamed in.
  r.slack.stopError = new Error("An API error occurred: message_not_in_streaming_state");
  await r.engine.handleEvent(dm("hello"));

  assert.deepEqual(r.slack.posts(), [], "the answer streamed, and is not repeated");
  assert.equal(r.slack.lastStatus(), "active", "the turn settles normally");
  assert.ok(r.warnings.some((w) => w.includes("stream close refused")));
  r.state.close();
});

test("nothing is appended to a stream Slack has already refused", async () => {
  const r = rig({
    script: () => [
      taskEvent("t1", "ctx"),
      artifactEvent("t1", "one ", false, false),
      artifactEvent("t1", "two ", true, false),
      artifactEvent("t1", "three", true, true),
      activityEvent("t1", { id: "a1", title: "Still working", status: "running" }),
      statusEvent("t1", TaskState.TASK_STATE_COMPLETED),
    ],
  });
  r.slack.appendError = new Error("An API error occurred: msg_too_long");
  await r.engine.handleEvent(dm("hello"));

  const appends = r.slack.calls.filter((c) => c.type === "append" || c.type === "activity");
  assert.equal(appends.length, 0, "the refused append is the last one attempted");
  assert.equal(r.slack.calls.filter((c) => c.type === "stop").length, 0, "and it is not stopped");
  assert.deepEqual(r.slack.posts(), ["one two three"]);
  r.state.close();
});

test("a turn of many small steps rolls over before Slack refuses it", async () => {
  const cards: AgentActivity[] = Array.from({ length: 6 }, (_, i) => ({
    id: `a${i}`,
    title: `Step number ${i}`,
    status: "running" as const,
  }));
  const r = rig(
    {
      script: () => [
        taskEvent("t1", "ctx"),
        activityEvent("t1", ...cards),
        // The same cards again, settling: an update in place, not more message.
        activityEvent("t1", ...cards.map((c) => ({ ...c, status: "done" as const }))),
        artifactEvent("t1", "done", true, true),
        statusEvent("t1", TaskState.TASK_STATE_COMPLETED),
      ],
    },
    { streamTextBudget: 160 },
  );
  await r.engine.handleEvent(dm("do a lot of small things"));

  const starts = r.slack.calls.filter((c) => c.type === "startStream").length;
  assert.ok(starts > 1, `the timeline spans several messages (got ${starts})`);
  assert.equal(r.slack.posts().length, 0, "nothing had to fall back to a plain message");
  assert.equal(r.slack.lastStatus(), "active");
  r.state.close();
});

test("a normal-length answer streams exactly as before", async () => {
  const r = rig({
    script: () => [
      taskEvent("t1", "ctx"),
      artifactEvent("t1", "a modest answer", false, true),
      statusEvent("t1", TaskState.TASK_STATE_COMPLETED),
    ],
  });
  await r.engine.handleEvent(dm("hi"));
  assert.equal(r.slack.calls.filter((c) => c.type === "startStream").length, 1);
  assert.equal(r.slack.calls.filter((c) => c.type === "stop").length, 1);
  r.state.close();
});

// ---------------------------------------------------------------- questions

const DEPLOY_QUESTION = [
  {
    question: "Which environment should I deploy to?",
    header: "Target",
    multiSelect: false,
    options: [
      { label: "staging", description: "Rehearse first" },
      { label: "production", description: "Straight to the real thing" },
    ],
  },
];

function questionEvent(taskId: string, questions: unknown = DEPLOY_QUESTION): A2AEvent {
  return {
    kind: "status",
    taskId,
    contextId: "ctx",
    state: TaskState.TASK_STATE_INPUT_REQUIRED,
    metadata: { [META_QUEUED_TURN_COUNT]: 0, [META_QUESTIONS]: questions },
  };
}

function tap(messageTs: string, value: string, userId = HUMAN) {
  return {
    kind: "block_action" as const,
    channel: CH,
    messageTs,
    threadTs: TH,
    userId,
    actions: [{ actionId: `thicket_q:answer:0:${value.split(":")[1]}`, blockId: "thicket_q:0", value }],
  };
}

test("an agent question with options renders as blocks in the thread, after the prose", async () => {
  const r = rig({
    script: () => [
      taskEvent("t1", "ctx"),
      artifactEvent("t1", "Which environment should I deploy to?", false, true),
      questionEvent("t1"),
    ],
  });
  await r.engine.handleEvent(dm("deploy it"));

  const kinds = r.slack.calls.map((c) => c.type);
  const stop = kinds.indexOf("stop");
  const posted = kinds.indexOf("postBlocks");
  assert.ok(posted > stop, `blocks follow the closed stream: ${kinds.join(",")}`);
  const call = r.slack.calls[posted]!;
  assert.ok(call.type === "postBlocks");
  assert.equal(call.threadTs, TH);
  assert.equal(call.text, "Which environment should I deploy to?");
  assert.ok(JSON.stringify(call.blocks).includes('"button"'), "the options are buttons");
  assert.ok(r.state.questionFor(CH, call.ts) !== undefined, "the question is remembered for its tap");
  assert.equal(r.slack.lastStatus(), "active", "the thread is the user's again");
  r.state.close();
});

test("a tap answers the question: the choice reaches the agent as the next message", async () => {
  const r = rig({
    script: (_message, turn) =>
      turn === 0
        ? [taskEvent("t1", "ctx"), questionEvent("t1")]
        : [
            taskEvent("t2", "ctx"),
            artifactEvent("t2", "Deploying to production.", false, true),
            statusEvent("t2", TaskState.TASK_STATE_COMPLETED),
          ],
  });
  await r.engine.handleEvent(dm("deploy it"));
  const posted = r.slack.calls.find((c) => c.type === "postBlocks");
  assert.ok(posted?.type === "postBlocks");

  await r.engine.handleEvent(tap(posted.ts, "0:1"));

  assert.equal(r.client.streamed.length, 2, "the tap became a turn");
  const answer = r.client.streamed[1]!;
  // The agent minted "ctx" on the first turn, so that is the conversation now.
  assert.equal(answer.contextId, r.state.contextFor(CH, TH), "same conversation");
  assert.equal(answer.contextId, "ctx");
  assert.equal(
    answer.parts[0]?.content?.$case === "text" ? answer.parts[0].content.value : "",
    "Target: production",
  );
  const update = r.slack.calls.find((c) => c.type === "update");
  assert.ok(update?.type === "update", "the question message is redrawn");
  assert.equal(update.ts, posted.ts);
  assert.match(update.text, /production/);
  assert.equal(JSON.stringify(update.blocks).includes('"button"'), false, "nothing left to tap");
  assert.equal(r.state.questionFor(CH, posted.ts), undefined, "answered questions are forgotten");
  assert.equal(r.slack.reactions.length, 1, "no second eyes: the thread was already engaged");
  assert.equal(r.slack.lastStatus(), "active");
  r.state.close();
});

test("a tap after the question was answered gets a note, not a turn", async () => {
  const r = rig({
    script: () => [taskEvent("t1", "ctx"), questionEvent("t1")],
  });
  await r.engine.handleEvent(dm("deploy it"));
  const posted = r.slack.calls.find((c) => c.type === "postBlocks");
  assert.ok(posted?.type === "postBlocks");
  await r.engine.handleEvent(tap(posted.ts, "0:0"));
  const turnsBefore = r.client.streamed.length;

  await r.engine.handleEvent(tap(posted.ts, "0:1"));

  assert.equal(r.client.streamed.length, turnsBefore, "no second turn");
  assert.ok(
    r.slack.posts().some((p) => /already been answered/.test(p)),
    "the stale tap is answered with a gentle note in the thread",
  );
  r.state.close();
});

test("a tap on something that is not a thicket question is ignored", async () => {
  const r = rig({ script: () => [taskEvent("t1", "ctx"), questionEvent("t1")] });
  await r.engine.handleEvent(dm("deploy it"));
  const calls = r.slack.calls.length;
  await r.engine.handleEvent({
    kind: "block_action",
    channel: CH,
    messageTs: "9.9",
    userId: HUMAN,
    actions: [{ actionId: "some_other_app", blockId: "b", value: "x" }],
  });
  assert.equal(r.slack.calls.length, calls, "not even a note");
  assert.equal(r.client.streamed.length, 1);
  r.state.close();
});

test("a form submits from the message state; a blank question is sent back to the form", async () => {
  const two = [
    DEPLOY_QUESTION[0],
    {
      question: "Which features do you want on?",
      header: "Features",
      multiSelect: true,
      options: [{ label: "metrics" }, { label: "tracing" }],
    },
  ];
  const r = rig({
    script: (_message, turn) =>
      turn === 0 ? [taskEvent("t1", "ctx"), questionEvent("t1", two)] : [taskEvent("t2", "ctx")],
  });
  await r.engine.handleEvent(dm("set it up"));
  const posted = r.slack.calls.find((c) => c.type === "postBlocks");
  assert.ok(posted?.type === "postBlocks");
  assert.ok(JSON.stringify(posted.blocks).includes('"radio_buttons"'));
  assert.ok(JSON.stringify(posted.blocks).includes('"checkboxes"'));

  const submit = { actionId: "thicket_q:submit", blockId: "thicket_q:controls", value: "submit" };
  await r.engine.handleEvent({
    kind: "block_action",
    channel: CH,
    messageTs: posted.ts,
    threadTs: TH,
    userId: HUMAN,
    actions: [submit],
    state: { "thicket_q:0": { "thicket_q:answer:0": ["0:0"] } },
  });
  assert.equal(r.client.streamed.length, 1, "half a form is not an answer");
  assert.ok(r.slack.posts().some((p) => /every question/.test(p)));

  await r.engine.handleEvent({
    kind: "block_action",
    channel: CH,
    messageTs: posted.ts,
    threadTs: TH,
    userId: HUMAN,
    actions: [submit],
    state: {
      "thicket_q:0": { "thicket_q:answer:0": ["0:0"] },
      "thicket_q:1": { "thicket_q:answer:1": ["1:0", "1:1"] },
    },
  });
  assert.equal(r.client.streamed.length, 2);
  const answer = r.client.streamed[1]!.parts[0];
  assert.equal(
    answer?.content?.$case === "text" ? answer.content.value : "",
    "Target: staging\nFeatures: metrics, tracing",
  );
  r.state.close();
});

test("input-required without structure behaves exactly as before: no blocks", async () => {
  const r = rig({
    script: () => [
      taskEvent("t1", "ctx"),
      artifactEvent("t1", "What do you mean by 'soon'?", false, true),
      statusEvent("t1", TaskState.TASK_STATE_INPUT_REQUIRED),
    ],
  });
  await r.engine.handleEvent(dm("do it soon"));
  assert.equal(r.slack.calls.some((c) => c.type === "postBlocks"), false);
  assert.equal(r.slack.lastStatus(), "active");
  r.state.close();
});

test("a surface that refuses the blocks keeps the prose question and the thread", async () => {
  const r = rig({
    script: () => [
      taskEvent("t1", "ctx"),
      artifactEvent("t1", "Which environment should I deploy to?", false, true),
      questionEvent("t1"),
    ],
  });
  r.slack.blocksError = new Error("invalid_blocks");
  await r.engine.handleEvent(dm("deploy it"));
  assert.equal(r.slack.lastStatus(), "active");
  assert.ok(r.warnings.some((w) => /question blocks refused/.test(w)));
  assert.equal(r.slack.calls.filter((c) => c.type === "append").length, 1, "the prose still streamed");
  r.state.close();
});

test("a question survives a bridge restart: the tap still resolves from the database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thicket-q-"));
  const dbPath = join(dir, "bridge.db");
  try {
    const first = rig({ script: () => [taskEvent("t1", "ctx"), questionEvent("t1")] }, { dbPath });
    await first.engine.handleEvent(dm("deploy it"));
    const posted = first.slack.calls.find((c) => c.type === "postBlocks");
    assert.ok(posted?.type === "postBlocks");
    first.state.close();

    const second = rig({ script: () => [taskEvent("t2", "ctx")] }, { dbPath });
    await second.engine.handleEvent(tap(posted.ts, "0:0"));
    assert.equal(second.client.streamed.length, 1, "the tap became a turn on the new process");
    second.state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------- workspace binding

function mention(channel: string, text: string, ts = "1724650001.000001") {
  return {
    kind: "mention" as const,
    channel,
    threadTs: ts,
    text,
    messageTs: ts,
    files: [],
    authorId: HUMAN,
    viaApp: false,
  };
}

test("a mention in a channel bound by id carries the workspace name; a DM never does", async () => {
  const r = rig(
    { script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)] },
    { bindings: { C0PROJ00001: "homestead" } },
  );
  await r.engine.handleEvent(mention("C0PROJ00001", "fix the backup timer"));
  await r.engine.handleEvent(dm("hello"));
  await r.engine.handleEvent(mention("C0OTHER0001", "hi", "1724650009.000001"));
  const [bound, direct, unbound] = r.client.streamed;
  assert.equal(bound?.metadata?.[META_WORKSPACE], "homestead");
  assert.equal(META_WORKSPACE in (direct?.metadata ?? {}), false, "DMs are unchanged");
  assert.equal(META_WORKSPACE in (unbound?.metadata ?? {}), false, "unbound channels are unchanged");
  assert.equal(r.slack.channelNameLookups, 0, "id bindings never ask Slack");
  r.state.close();
});

test("a binding written as #name resolves the channel's name once and remembers it", async () => {
  const r = rig(
    { script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)] },
    { bindings: { "#proj-homestead": "homestead" } },
  );
  r.slack.channelNames.set("C0PROJ00001", "proj-homestead");
  await r.engine.handleEvent(mention("C0PROJ00001", "one"));
  await r.engine.handleEvent(mention("C0PROJ00001", "two", "1724650002.000001"));
  assert.equal(r.client.streamed[0]?.metadata?.[META_WORKSPACE], "homestead");
  assert.equal(r.client.streamed[1]?.metadata?.[META_WORKSPACE], "homestead");
  assert.equal(r.slack.channelNameLookups, 1, "asked once");
  // A thread-context message in the bound channel carries it too.
  await r.engine.handleEvent({
    kind: "thread_message",
    channel: "C0PROJ00001",
    threadTs: "1724650001.000001",
    text: "fyi",
    messageTs: "1724650003.000001",
    files: [],
    authorId: HUMAN,
    viaApp: false,
  });
  assert.equal(r.client.sent[0]?.metadata?.[META_WORKSPACE], "homestead");
  r.state.close();
});

test("when the channel's name cannot be resolved, the turn is refused in-thread, not run elsewhere", async () => {
  const r = rig(
    { script: () => [taskEvent("t1", "ctx"), statusEvent("t1", TaskState.TASK_STATE_COMPLETED)] },
    { bindings: { "#proj-homestead": "homestead" } },
  );
  r.slack.channelNameError = new Error("ratelimited");
  await r.engine.handleEvent(mention("C0PROJ00001", "fix it"));
  assert.equal(r.client.streamed.length, 0, "no turn");
  assert.ok(r.slack.posts().some((p) => /won't guess which workspace/.test(p)));
  assert.equal(r.slack.lastStatus(), "active", "the thread is handed back");
  assert.ok(r.warnings.some((w) => /workspace unresolved/.test(w)));
  r.state.close();
});
