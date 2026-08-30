import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { TaskState } from "@a2a-js/sdk";
import type { AgentExecutionEvent, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { ServerCallContext } from "@a2a-js/sdk/server";

import { AttachmentStore, META_FILE_SIZE } from "./attachments.js";
import { ClaudeAgentExecutor, phonePreamble, threadPreamble } from "./executor.js";
import { UnknownWorkspaceError } from "./session-manager.js";
import {
  META_CANCELLED,
  META_CONTEXT_ONLY,
  META_PHONE_CALL,
  META_PHONE_DIRECTION,
  META_PHONE_FROM,
  META_PHONE_KIND,
  META_PHONE_SESSION_STARTED,
  META_PHONE_TO,
  META_PRIORITY,
  META_QUEUE_STATE,
  META_SHOULD_QUERY,
  META_SLACK_CHANNEL,
  META_SLACK_THREAD,
  META_STILL_QUEUED,
  META_WORKSPACE,
  type SessionHandle,
} from "./types.js";

function loadFixture(name: string): SDKMessage[] {
  const raw = readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8");
  return JSON.parse(raw) as SDKMessage[];
}

class FrameQueue implements AsyncIterable<SDKMessage> {
  private buffer: SDKMessage[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(...frames: SDKMessage[]): void {
    this.buffer.push(...frames);
    this.waiter?.();
  }

  close(): void {
    this.closed = true;
    this.waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (;;) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = null;
    }
  }
}

interface FakeSession extends SessionHandle {
  queue: FrameQueue;
  sent: SDKUserMessage[];
  interruptCalls: { cancelQueued?: boolean }[];
}

function fakeSession(receipt: SDKControlInterruptResponse | undefined): FakeSession {
  const queue = new FrameQueue();
  const sent: SDKUserMessage[] = [];
  const interruptCalls: { cancelQueued?: boolean }[] = [];
  return {
    queue,
    sent,
    interruptCalls,
    frames: queue,
    send(message) {
      sent.push(message);
    },
    async interrupt(options) {
      interruptCalls.push(options ?? {});
      return receipt;
    },
  };
}

function stubBus(events: AgentExecutionEvent[]): ExecutionEventBus {
  return {
    publish: (event) => void events.push(event),
    on() {
      return this;
    },
    off() {
      return this;
    },
    once() {
      return this;
    },
    removeAllListeners() {
      return this;
    },
    finished() {},
  } as ExecutionEventBus;
}

function requestContext(
  taskId: string,
  contextId: string,
  text: string,
  metadata: Record<string, unknown> = {},
  files: { url: string; filename: string; mediaType: string; size: number }[] = [],
): RequestContext {
  const message = {
    messageId: `${taskId}-inbound`,
    contextId,
    taskId: "",
    role: 1,
    parts: [
      {
        content: { $case: "text" as const, value: text },
        mediaType: "text/plain",
        filename: "",
        metadata: {},
      },
      ...files.map((file) => ({
        content: { $case: "url" as const, value: file.url },
        mediaType: file.mediaType,
        filename: file.filename,
        metadata: { [META_FILE_SIZE]: file.size },
      })),
    ],
    metadata,
    extensions: [],
    referenceTaskIds: [],
  };
  const request = { message, configuration: undefined, metadata: undefined, tenant: "" };
  // Only the fields the executor reads are populated.
  return {
    request,
    taskId,
    contextId,
    context: new ServerCallContext(),
    get userMessage() {
      return message;
    },
  } as unknown as RequestContext;
}

/** Rewrites a fixture's join keys to the uuid the executor stamped. */
function withUuid(frames: SDKMessage[], uuid: string): SDKMessage[] {
  return frames.map((frame) => {
    if ("user_message_uuid" in frame && frame.user_message_uuid !== undefined) {
      return { ...frame, user_message_uuid: uuid } as SDKMessage;
    }
    return frame;
  });
}

test("execute stamps a uuid, streams the turn, and resolves at terminal", async () => {
  const session = fakeSession(undefined);
  const events: AgentExecutionEvent[] = [];
  const executor = new ClaudeAgentExecutor({
    sessions: { sessionFor: () => session },
    uuid: () => "fixed-uuid-1",
    now: () => "2026-08-26T00:00:00.000Z",
  });

  const pending = executor.execute(requestContext("task-1", "ctx-1", "what is 2+2?"), stubBus(events));
  // The send reached the session with the stamp the frames will echo.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.sent.length, 1);
  assert.equal(session.sent[0]?.uuid, "fixed-uuid-1");
  assert.equal(session.sent[0]?.message.content, "what is 2+2?");

  session.queue.push(...withUuid(loadFixture("plain-turn"), "fixed-uuid-1"));
  await pending;

  assert.deepEqual(
    events.map((e) => e.kind),
    ["task", "artifactUpdate", "statusUpdate"],
  );
  const terminal = events[events.length - 1];
  assert.ok(terminal?.kind === "statusUpdate");
  assert.equal(terminal.data.status?.state, TaskState.TASK_STATE_COMPLETED);
  session.queue.close();
});

test("cancelTask with interrupt_cancel_queued_v1 cancels queued sends", async () => {
  const session = fakeSession({ still_queued: [], cancelled: ["queued-uuid-2"] });
  const events: AgentExecutionEvent[] = [];
  const executor = new ClaudeAgentExecutor({
    sessions: { sessionFor: () => session },
    uuid: () => "fixed-uuid-1",
    now: () => "2026-08-26T00:00:00.000Z",
  });

  const bus = stubBus(events);
  const pending = executor.execute(requestContext("task-1", "ctx-1", "long job"), bus);
  await new Promise((resolve) => setImmediate(resolve));
  // Advertise capabilities and open the turn, then cancel mid-flight.
  const frames = withUuid(loadFixture("interrupted-turn"), "fixed-uuid-1");
  session.queue.push(frames[0]!, frames[1]!);
  await new Promise((resolve) => setImmediate(resolve));

  await executor.cancelTask("task-1", bus);
  assert.deepEqual(session.interruptCalls, [{ cancelQueued: true }]);

  const cancelEvent = events[events.length - 1];
  assert.ok(cancelEvent?.kind === "statusUpdate");
  assert.equal(cancelEvent.data.status?.state, TaskState.TASK_STATE_CANCELED);
  assert.equal(cancelEvent.data.metadata?.[META_QUEUE_STATE], "queued-cancelled");
  assert.deepEqual(cancelEvent.data.metadata?.[META_CANCELLED], ["queued-uuid-2"]);
  assert.deepEqual(cancelEvent.data.metadata?.[META_STILL_QUEUED], []);

  // The interrupted turn's own result must not emit a second terminal.
  session.queue.push(frames[2]!, frames[3]!);
  await pending;
  const terminals = events.filter(
    (e) => e.kind === "statusUpdate" && e.data.status?.state === TaskState.TASK_STATE_CANCELED,
  );
  assert.equal(terminals.length, 1);
  session.queue.close();
});

test("cancelTask without the capability reports what remains queued", async () => {
  const session = fakeSession({ still_queued: ["queued-uuid-2", "queued-uuid-3"] });
  const events: AgentExecutionEvent[] = [];
  const executor = new ClaudeAgentExecutor({
    sessions: { sessionFor: () => session },
    uuid: () => "fixed-uuid-1",
    now: () => "2026-08-26T00:00:00.000Z",
  });

  const bus = stubBus(events);
  void executor.execute(requestContext("task-1", "ctx-1", "long job"), bus);
  await new Promise((resolve) => setImmediate(resolve));
  // This CLI advertises only interrupt_receipt_v1 (no cancel_queued).
  const frames = withUuid(loadFixture("tool-use-turn"), "fixed-uuid-1");
  session.queue.push(frames[0]!, frames[1]!);
  await new Promise((resolve) => setImmediate(resolve));

  await executor.cancelTask("task-1", bus);
  assert.deepEqual(session.interruptCalls, [{ cancelQueued: false }]);

  const cancelEvent = events[events.length - 1];
  assert.ok(cancelEvent?.kind === "statusUpdate");
  assert.equal(cancelEvent.data.metadata?.[META_QUEUE_STATE], "queued-survives");
  assert.deepEqual(cancelEvent.data.metadata?.[META_STILL_QUEUED], [
    "queued-uuid-2",
    "queued-uuid-3",
  ]);
  session.queue.close();
});

test("cancelTask on a CLI with no receipt reports the queue as unknown", async () => {
  const session = fakeSession(undefined);
  const events: AgentExecutionEvent[] = [];
  const executor = new ClaudeAgentExecutor({
    sessions: { sessionFor: () => session },
    uuid: () => "fixed-uuid-1",
    now: () => "2026-08-26T00:00:00.000Z",
  });

  const bus = stubBus(events);
  void executor.execute(requestContext("task-1", "ctx-1", "job"), bus);
  await new Promise((resolve) => setImmediate(resolve));
  const frames = withUuid(loadFixture("error-result"), "fixed-uuid-1");
  session.queue.push(frames[0]!, frames[1]!);
  await new Promise((resolve) => setImmediate(resolve));

  await executor.cancelTask("task-1", bus);
  const cancelEvent = events[events.length - 1];
  assert.ok(cancelEvent?.kind === "statusUpdate");
  assert.equal(cancelEvent.data.metadata?.[META_QUEUE_STATE], "unknown");
  session.queue.close();
});

test("shouldQuery:false metadata: context-only send, no turn, immediate completion", async () => {
  const session = fakeSession(undefined);
  const events: AgentExecutionEvent[] = [];
  const executor = new ClaudeAgentExecutor({
    sessions: { sessionFor: () => session },
    uuid: () => "fixed-uuid-1",
    now: () => "2026-08-26T00:00:00.000Z",
  });

  // Resolves without any frames from the session: no turn answers it.
  await executor.execute(
    requestContext("task-ambient", "ctx-1", "fyi: deploy window is Friday", {
      [META_SHOULD_QUERY]: false,
    }),
    stubBus(events),
  );

  assert.equal(session.sent.length, 1);
  assert.equal(session.sent[0]?.shouldQuery, false, "SDKUserMessage carries shouldQuery:false");
  assert.equal(session.sent[0]?.message.content, "fyi: deploy window is Friday");

  assert.equal(events.length, 1, "exactly one event: the acknowledgement task");
  const ack = events[0];
  assert.ok(ack?.kind === "task");
  assert.equal(ack.data.id, "task-ambient");
  assert.equal(ack.data.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(ack.data.metadata?.[META_CONTEXT_ONLY], true);

  // A later real turn binds to its own send, unconfused by the ambient one.
  const turnEvents: AgentExecutionEvent[] = [];
  const pending = executor.execute(
    requestContext("task-real", "ctx-1", "when is the deploy?"),
    stubBus(turnEvents),
  );
  await new Promise((resolve) => setImmediate(resolve));
  session.queue.push(...withUuid(loadFixture("plain-turn"), "fixed-uuid-1"));
  await pending;
  const terminal = turnEvents[turnEvents.length - 1];
  assert.ok(terminal?.kind === "statusUpdate");
  assert.equal(terminal.data.status?.state, TaskState.TASK_STATE_COMPLETED);
  session.queue.close();
});

test("thicket.priority metadata maps onto SDKUserMessage.priority", async () => {
  const session = fakeSession(undefined);
  const executor = new ClaudeAgentExecutor({
    sessions: { sessionFor: () => session },
    uuid: () => "fixed-uuid-1",
    now: () => "2026-08-26T00:00:00.000Z",
  });

  // Context-only send so execute resolves without scripted frames.
  await executor.execute(
    requestContext("task-p1", "ctx-1", "urgent note", {
      [META_SHOULD_QUERY]: false,
      [META_PRIORITY]: "now",
    }),
    stubBus([]),
  );
  assert.equal(session.sent[0]?.priority, "now");

  // Invalid values are dropped rather than passed through.
  await executor.execute(
    requestContext("task-p2", "ctx-1", "odd note", {
      [META_SHOULD_QUERY]: false,
      [META_PRIORITY]: "immediately",
    }),
    stubBus([]),
  );
  assert.equal(session.sent[1]?.priority, undefined);
  session.queue.close();
});

// --------------------------------------------------------------- attachments

const UPLOAD = {
  url: "https://bridge.example.ts.net/files/F1",
  filename: "quarterly.csv",
  mediaType: "text/csv",
  size: 11,
};

function servingFetch(body = "hello world"): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: unknown) => {
    calls.push(String(input));
    return new Response(body);
  }) as unknown as typeof fetch;
  return { impl, calls };
}


/**
 * Waits until the executor has pushed its send into the session — which
 * happens only after registerSend, so frames pushed afterwards always
 * find their turn. The fixed 20ms sleep this replaces lost that race
 * under a loaded parallel test run: the attachment preamble (fetch plus
 * disk writes) could outlast the sleep, the fixture frames arrived
 * before the send was registered, the translator dropped them as an
 * unknown uuid, and the turn never settled (task 030).
 */
async function untilSent(session: FakeSession, count = 1): Promise<void> {
  for (let i = 0; i < 5000; i += 1) {
    if (session.sent.length >= count) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for send #${count}`);
}

test("a message from Slack tells the model where it is; one from anywhere else does not", async () => {
  const session = fakeSession(undefined);
  const executor = new ClaudeAgentExecutor({
    sessions: { sessionFor: () => session },
    uuid: () => "uuid-1",
  });
  const events: AgentExecutionEvent[] = [];
  const ctx = requestContext("task-1", "ctx-1", "read this thread back", {
    [META_SLACK_CHANNEL]: "D0123",
    [META_SLACK_THREAD]: "1724650000.000100",
  });
  const running = executor.execute(ctx, stubBus(events));
  await untilSent(session);
  session.queue.push(...withUuid(loadFixture("plain-turn"), "uuid-1"));
  await running;

  const prompt = String(session.sent[0]?.message.content);
  assert.match(prompt, /channel D0123, thread 1724650000\.000100/);
  assert.match(prompt, /channel=D0123 with thread_ts=1724650000\.000100/);
  assert.ok(
    prompt.indexOf("D0123") < prompt.indexOf("read this thread back"),
    "where you are is context; the user's words stay the instruction",
  );

  // The MCP path and scheduled prompts carry no coordinates: no line at all.
  assert.equal(threadPreamble(requestContext("t", "c", "hi").userMessage), "");
  assert.equal(
    threadPreamble(requestContext("t", "c", "hi", { [META_SLACK_CHANNEL]: "D0123" }).userMessage),
    "",
    "half a location is no location",
  );
});

test("a message from a phone call tells the model it is a voice session; one without the keys does not", async () => {
  const session = fakeSession(undefined);
  const executor = new ClaudeAgentExecutor({
    sessions: { sessionFor: () => session },
    uuid: () => "uuid-1",
    now: () => "2026-08-30T10:12:00.000Z",
  });
  const events: AgentExecutionEvent[] = [];
  const phone = {
    [META_PHONE_CALL]: "CA0000000000000000000000000000000f",
    [META_PHONE_FROM]: "+15550100001",
    [META_PHONE_TO]: "+15550100002",
    [META_PHONE_DIRECTION]: "inbound",
    [META_PHONE_KIND]: "speech",
    [META_PHONE_SESSION_STARTED]: "2026-08-30T10:00:00.000Z",
  };
  const ctx = requestContext("task-1", "ctx-1", "what is the disk situation on hearth", phone);
  const running = executor.execute(ctx, stubBus(events));
  await untilSent(session);
  session.queue.push(...withUuid(loadFixture("plain-turn"), "uuid-1"));
  await running;

  const prompt = String(session.sent[0]?.message.content);
  assert.match(prompt, /voice call with the operator, who authenticated with their PIN/);
  assert.match(prompt, /has run 12 minutes/);
  assert.match(prompt, /read aloud/);
  assert.ok(
    prompt.indexOf("voice call") < prompt.indexOf("disk situation"),
    "the call is context; the operator's words stay the instruction",
  );
  // Never the identifier, never a number: the bridge holds those, not the model.
  assert.doesNotMatch(prompt, /CA0000/);
  assert.doesNotMatch(prompt, /\+1555/);

  // No call, no line — and a call is named by its identifier, nothing less.
  assert.equal(phonePreamble(requestContext("t", "c", "hi").userMessage), "");
  assert.equal(
    phonePreamble(requestContext("t", "c", "hi", { [META_PHONE_FROM]: "+15550100001" }).userMessage),
    "",
  );
  // Digits, events and interruptions say what they are; speech says nothing extra.
  const kind = (k: string) =>
    phonePreamble(
      requestContext("t", "c", "1234", { ...phone, [META_PHONE_KIND]: k }).userMessage,
      () => "2026-08-30T10:00:30.000Z",
    );
  assert.match(kind("dtmf"), /digits the operator keyed/);
  assert.match(kind("event"), /event from the call/);
  assert.match(kind("interrupted"), /spoke over your previous reply/);
  assert.doesNotMatch(kind("speech"), /keyed|event from|spoke over/);
  assert.match(kind("speech"), /began under a minute ago/);
});

test("an attached file is fetched and its path leads the prompt", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "exec-attach-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const session = fakeSession(undefined);
  const { impl, calls } = servingFetch();
  const executor = new ClaudeAgentExecutor({
    sessions: { sessionFor: () => session },
    uuid: () => "uuid-1",
    attachments: new AttachmentStore({ dir, fetchImpl: impl }),
  });

  const events: AgentExecutionEvent[] = [];
  const ctx = requestContext("task-1", "ctx-1", "what do you make of this?", {}, [UPLOAD]);
  const running = executor.execute(ctx, stubBus(events));
  await untilSent(session);
  session.queue.push(...withUuid(loadFixture("plain-turn"), "uuid-1"));
  await running;

  assert.deepEqual(calls, [UPLOAD.url], "fetched eagerly, without the model asking");
  const content = session.sent[0]?.message.content;
  assert.equal(typeof content, "string");
  const prompt = String(content);
  assert.match(prompt, /saved on this machine/);
  assert.match(prompt, /quarterly\.csv \(text\/csv, 11 B\)/);
  assert.ok(
    prompt.indexOf("quarterly.csv") < prompt.indexOf("what do you make of this?"),
    "attachments are context; the user's words stay the instruction",
  );
});

test("an agent that refuses attachments never fetches, and says so", async (t) => {
  const session = fakeSession(undefined);
  const executor = new ClaudeAgentExecutor({
    sessions: { sessionFor: () => session },
    uuid: () => "uuid-1",
    // No store: the roster policy is expressed by its absence.
  });
  t.after(() => session.queue.close());

  const events: AgentExecutionEvent[] = [];
  const ctx = requestContext("task-1", "ctx-1", "read this", {}, [UPLOAD]);
  const running = executor.execute(ctx, stubBus(events));
  await untilSent(session);
  session.queue.push(...withUuid(loadFixture("plain-turn"), "uuid-1"));
  await running;

  const prompt = String(session.sent[0]?.message.content);
  assert.match(prompt, /does not accept attachments/);
  assert.match(prompt, /read this/, "the turn still runs");
});

test("a failed fetch degrades to a note; the turn still answers", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "exec-attach-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const session = fakeSession(undefined);
  const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const warnings: string[] = [];
  const executor = new ClaudeAgentExecutor({
    sessions: { sessionFor: () => session },
    uuid: () => "uuid-1",
    onWarning: (msg) => warnings.push(msg),
    attachments: new AttachmentStore({ dir, fetchImpl: failing }),
  });

  const events: AgentExecutionEvent[] = [];
  const ctx = requestContext("task-1", "ctx-1", "read this", {}, [UPLOAD]);
  const running = executor.execute(ctx, stubBus(events));
  await untilSent(session);
  session.queue.push(...withUuid(loadFixture("plain-turn"), "uuid-1"));
  await running;

  const prompt = String(session.sent[0]?.message.content);
  assert.match(prompt, /could not be retrieved/);
  assert.match(prompt, /read this/);
  assert.equal(warnings.length, 1);
  const terminal = events.filter((e) => e.kind === "statusUpdate").at(-1);
  assert.equal(terminal?.data.status?.state, TaskState.TASK_STATE_COMPLETED);
});

test("the workspace a message names reaches the session provider every turn", async () => {
  const session = fakeSession(undefined);
  const asked: (string | undefined)[] = [];
  const executor = new ClaudeAgentExecutor({
    sessions: {
      sessionFor: (_contextId, options) => {
        asked.push(options?.workspace);
        return session;
      },
    },
    uuid: () => "uuid-1",
  });
  const events: AgentExecutionEvent[] = [];
  const ctx = requestContext("task-1", "ctx-1", "hi", { [META_WORKSPACE]: "homestead" });
  const running = executor.execute(ctx, stubBus(events));
  await untilSent(session);
  session.queue.push(...withUuid(loadFixture("plain-turn"), "uuid-1"));
  await running;
  assert.deepEqual(asked, ["homestead"]);
});

test("an undeclared workspace refuses the turn out loud instead of running elsewhere", async () => {
  const session = fakeSession(undefined);
  const executor = new ClaudeAgentExecutor({
    sessions: {
      sessionFor: (_contextId, options) => {
        if (options?.workspace !== undefined) {
          throw new UnknownWorkspaceError(options.workspace, ["homestead"]);
        }
        return session;
      },
    },
    uuid: () => "uuid-1",
  });
  const events: AgentExecutionEvent[] = [];
  const ctx = requestContext("task-1", "ctx-1", "fix it", { [META_WORKSPACE]: "nowhere" });
  await executor.execute(ctx, stubBus(events));

  assert.equal(session.sent.length, 0, "nothing reached the model");
  assert.deepEqual(
    events.map((e) => e.kind),
    ["task", "statusUpdate"],
  );
  const status = events[1]!;
  assert.ok(status.kind === "statusUpdate");
  assert.equal(status.data.status?.state, TaskState.TASK_STATE_FAILED);
  const text = status.data.status?.message?.parts[0]?.content;
  assert.ok(text?.$case === "text");
  assert.match(text.value, /workspace "nowhere" is not declared/);
  assert.match(text.value, /declares: homestead/);
});
