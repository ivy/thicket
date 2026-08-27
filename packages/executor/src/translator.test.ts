import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { TaskState } from "@a2a-js/sdk";
import type { AgentExecutionEvent } from "@a2a-js/sdk/server";

import { TurnTranslator, ASSISTANT_TEXT_ARTIFACT_ID } from "./translator.js";
import {
  META_FOLDED_MESSAGE_IDS,
  META_QUEUED_TURN_COUNT,
  type PendingSend,
} from "./types.js";

function loadFixture(name: string): SDKMessage[] {
  const raw = readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8");
  return JSON.parse(raw) as SDKMessage[];
}

interface Harness {
  events: AgentExecutionEvent[];
  translator: TurnTranslator;
  warnings: string[];
}

function harness(): Harness {
  const events: AgentExecutionEvent[] = [];
  const warnings: string[] = [];
  let tick = 0;
  const translator = new TurnTranslator({
    publish: (event) => events.push(event),
    now: () => `2026-08-26T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    onWarning: (message) => warnings.push(message),
  });
  return { events, translator, warnings };
}

function send(uuid: string, n: number): PendingSend {
  return {
    uuid,
    messageId: `a2a-msg-${n}`,
    taskId: `task-${n}`,
    contextId: "ctx-1",
  };
}

function run(h: Harness, frames: SDKMessage[], end = true): void {
  for (const frame of frames) {
    h.translator.handleFrame(frame);
  }
  if (end) {
    h.translator.endStream();
  }
}

function kinds(events: AgentExecutionEvent[]): string[] {
  return events.map((e) => e.kind);
}

function artifactText(events: AgentExecutionEvent[]): string {
  return events
    .filter((e) => e.kind === "artifactUpdate")
    .map((e) => {
      const part = e.data.artifact?.parts[0];
      return part?.content?.$case === "text" ? part.content.value : "";
    })
    .join("");
}

function terminalStatus(events: AgentExecutionEvent[]) {
  const updates = events.filter((e) => e.kind === "statusUpdate");
  const last = updates[updates.length - 1];
  assert.ok(last && last.kind === "statusUpdate", "expected a status update");
  return last.data;
}

test("plain turn: task(working) then completed with result text", () => {
  const h = harness();
  h.translator.registerSend(send("send-a", 1));
  run(h, loadFixture("plain-turn"));

  assert.deepEqual(kinds(h.events), ["task", "artifactUpdate", "statusUpdate"]);
  const taskEvent = h.events[0];
  assert.ok(taskEvent?.kind === "task");
  assert.equal(taskEvent.data.id, "task-1");
  assert.equal(taskEvent.data.status?.state, TaskState.TASK_STATE_WORKING);

  const status = terminalStatus(h.events);
  assert.equal(status.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(status.taskId, "task-1");
  const messagePart = status.status?.message?.parts[0];
  assert.ok(messagePart?.content?.$case === "text");
  assert.equal(messagePart.content.value, "Hello! The answer is 4.");
  assert.equal(status.metadata?.[META_QUEUED_TURN_COUNT], 0);
  assert.deepEqual(status.metadata?.[META_FOLDED_MESSAGE_IDS], ["a2a-msg-1"]);
  assert.deepEqual(h.warnings, []);
});

test("tool-use turn: later frames without user_message_uuid still bind", () => {
  const h = harness();
  h.translator.registerSend(send("send-tool", 1));
  run(h, loadFixture("tool-use-turn"));

  // One task; both assistant text pieces flow into one artifact stream.
  assert.deepEqual(kinds(h.events), ["task", "artifactUpdate", "artifactUpdate", "statusUpdate"]);
  assert.equal(artifactText(h.events), "Checking the date. Today is Tuesday, August 26th.");
  const status = terminalStatus(h.events);
  assert.equal(status.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(status.taskId, "task-1");
});

test("streaming turn: chunks reconstruct the text; lastChunk on final chunk only", () => {
  const h = harness();
  h.translator.registerSend(send("send-stream", 1));
  run(h, loadFixture("streaming-turn"));

  const artifacts = h.events.filter((e) => e.kind === "artifactUpdate");
  assert.equal(artifacts.length, 3);
  assert.equal(artifactText(h.events), "The tide comes in at 6pm.");
  for (const [i, event] of artifacts.entries()) {
    assert.ok(event.kind === "artifactUpdate");
    assert.equal(event.data.artifact?.artifactId, ASSISTANT_TEXT_ARTIFACT_ID);
    assert.equal(event.data.append, i > 0, `chunk ${i} append`);
    assert.equal(event.data.lastChunk, i === artifacts.length - 1, `chunk ${i} lastChunk`);
  }
  // The complete-message frame after streaming must not duplicate text.
  const status = terminalStatus(h.events);
  assert.equal(status.status?.state, TaskState.TASK_STATE_COMPLETED);
});

test("error result: failed with the error text", () => {
  const h = harness();
  h.translator.registerSend(send("send-err", 1));
  run(h, loadFixture("error-result"));

  const status = terminalStatus(h.events);
  assert.equal(status.status?.state, TaskState.TASK_STATE_FAILED);
  const part = status.status?.message?.parts[0];
  assert.ok(part?.content?.$case === "text");
  assert.match(part.content.value, /tool crashed: Bash exited 137/);
});

test("interrupted turn (aborted frame): canceled, not completed", () => {
  const h = harness();
  h.translator.registerSend(send("send-int", 1));
  run(h, loadFixture("interrupted-turn"));

  const status = terminalStatus(h.events);
  assert.equal(status.status?.state, TaskState.TASK_STATE_CANCELED);
});

test("two sends coalesce into one task recording both message ids", () => {
  const h = harness();
  h.translator.registerSend(send("send-first", 1));
  h.translator.registerSend(send("send-second", 2));
  run(h, loadFixture("coalesced-turn"));

  const taskEvents = h.events.filter((e) => e.kind === "task");
  assert.equal(taskEvents.length, 1, "exactly one task for the coalesced turn");
  assert.ok(taskEvents[0]?.kind === "task");
  assert.equal(taskEvents[0].data.id, "task-1");

  const status = terminalStatus(h.events);
  assert.deepEqual(status.metadata?.[META_FOLDED_MESSAGE_IDS], ["a2a-msg-1", "a2a-msg-2"]);
  assert.equal(status.metadata?.[META_QUEUED_TURN_COUNT], 0);
});

test("queued_turn_count > 0 keeps the still-queued send pending", () => {
  const h = harness();
  h.translator.registerSend(send("send-first", 1));
  h.translator.registerSend(send("send-second", 2));
  const frames = loadFixture("coalesced-turn").map((frame) =>
    frame.type === "result" ? { ...frame, queued_turn_count: 1 } : frame,
  ) as SDKMessage[];
  run(h, frames, false);

  const status = terminalStatus(h.events);
  assert.deepEqual(status.metadata?.[META_FOLDED_MESSAGE_IDS], ["a2a-msg-1"]);
  assert.equal(status.metadata?.[META_QUEUED_TURN_COUNT], 1);

  // The queued send fails, not hangs, if the stream then dies.
  h.translator.endStream();
  const failed = h.events.filter(
    (e) => e.kind === "task" && e.data.status?.state === TaskState.TASK_STATE_FAILED,
  );
  assert.equal(failed.length, 1);
  assert.ok(failed[0]?.kind === "task");
  assert.equal(failed[0].data.id, "task-2");
});

test("agent question with deferred_tool_use: input-required, not terminal", () => {
  const h = harness();
  h.translator.registerSend(send("send-question", 1));
  run(h, loadFixture("input-required"), false);

  const status = terminalStatus(h.events);
  assert.equal(status.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
});

test("stream ending without a result yields failed, never a stuck working task", () => {
  const h = harness();
  h.translator.registerSend(send("send-crash", 1));
  run(h, loadFixture("no-result"));

  const status = terminalStatus(h.events);
  assert.equal(status.status?.state, TaskState.TASK_STATE_FAILED);
  assert.equal(status.taskId, "task-1");
  // The partial text was still flushed as a final chunk.
  assert.equal(artifactText(h.events), "I was about to say");
  const artifacts = h.events.filter((e) => e.kind === "artifactUpdate");
  const last = artifacts[artifacts.length - 1];
  assert.ok(last?.kind === "artifactUpdate");
  assert.equal(last.data.lastChunk, true);
});

test("capabilities are read from system/init", () => {
  const h = harness();
  run(h, loadFixture("plain-turn").slice(0, 1), false);
  assert.deepEqual(h.translator.capabilities, [
    "interrupt_receipt_v1",
    "interrupt_cancel_queued_v1",
  ]);
});
