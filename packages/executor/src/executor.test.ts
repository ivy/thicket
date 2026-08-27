import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type {
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { TaskState } from "@a2a-js/sdk";
import type { AgentExecutionEvent, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { ServerCallContext } from "@a2a-js/sdk/server";

import { ClaudeAgentExecutor } from "./executor.js";
import {
  META_CANCELLED,
  META_QUEUE_STATE,
  META_STILL_QUEUED,
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

function requestContext(taskId: string, contextId: string, text: string): RequestContext {
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
    ],
    metadata: {},
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
