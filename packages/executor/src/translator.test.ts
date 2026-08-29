import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { TaskState } from "@a2a-js/sdk";
import type { AgentExecutionEvent } from "@a2a-js/sdk/server";

import { TurnTranslator, ASSISTANT_TEXT_ARTIFACT_ID } from "./translator.js";
import {
  ACTIVITY_ARTIFACT_ID,
  parseAgentActivity,
  type AgentActivity,
} from "./activity.js";
import {
  META_FOLDED_INTO,
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

function activities(events: AgentExecutionEvent[]): AgentActivity[] {
  return events
    .filter((e) => e.kind === "artifactUpdate")
    .filter((e) => e.data.artifact?.artifactId === ACTIVITY_ARTIFACT_ID)
    .flatMap((e) => e.data.artifact?.parts ?? [])
    .map((part) => (part.content?.$case === "data" ? parseAgentActivity(part.content.value) : undefined))
    .filter((a): a is AgentActivity => a !== undefined);
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
  assert.deepEqual(kinds(h.events), [
    "task",
    "artifactUpdate",
    "artifactUpdate",
    "artifactUpdate",
    "artifactUpdate",
    "statusUpdate",
  ]);
  assert.equal(artifactText(h.events), "Checking the date. Today is Tuesday, August 26th.");
  const status = terminalStatus(h.events);
  assert.equal(status.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(status.taskId, "task-1");
});

test("tool-use turn: the tool_use opens a card and its tool_result closes it", () => {
  const h = harness();
  h.translator.registerSend(send("send-tool", 1));
  run(h, loadFixture("tool-use-turn"));

  const cards = activities(h.events);
  assert.deepEqual(cards, [
    { id: "toolu_1", title: "Running a command", status: "running", details: "date", icon: "code" },
    // The closing update redraws the card, so it carries the icon again.
    { id: "toolu_1", title: "Running a command", status: "done", icon: "code" },
  ]);
  const updates = h.events.filter((e) => e.kind === "artifactUpdate");
  const cardEvents = updates.filter(
    (e) => e.data.artifact?.artifactId === ACTIVITY_ARTIFACT_ID,
  );
  assert.equal(cardEvents[0]?.data.append, false, "first card opens the stream");
  assert.equal(cardEvents[1]?.data.append, true, "later cards append");
  assert.ok(
    cardEvents.every((e) => e.data.lastChunk === false),
    "the activity stream is never closed by a chunk flag",
  );
});

test("the card appears after the text it follows, not before", () => {
  const h = harness();
  h.translator.registerSend(send("send-tool", 1));
  run(h, loadFixture("tool-use-turn"));

  const ids = h.events
    .filter((e) => e.kind === "artifactUpdate")
    .map((e) => e.data.artifact?.artifactId);
  assert.deepEqual(ids, [
    ASSISTANT_TEXT_ARTIFACT_ID,
    ACTIVITY_ARTIFACT_ID,
    ACTIVITY_ARTIFACT_ID,
    ASSISTANT_TEXT_ARTIFACT_ID,
  ]);
});

test("a tool whose result never arrives is settled by the turn's outcome", () => {
  const h = harness();
  h.translator.registerSend(send("send-tool", 1));
  const frames = loadFixture("tool-use-turn");
  // Drop the tool_result frame: the card would otherwise spin forever.
  run(
    h,
    frames.filter((frame) => frame.type !== "user"),
  );

  assert.deepEqual(
    activities(h.events).map((a) => a.status),
    ["running", "done"],
  );
});

test("subagent tool traffic produces no cards", () => {
  const h = harness();
  h.translator.registerSend(send("send-tool", 1));
  const frames = loadFixture("tool-use-turn").map((frame) =>
    frame.type === "assistant" || frame.type === "user"
      ? { ...frame, parent_tool_use_id: "toolu_parent" }
      : frame,
  ) as SDKMessage[];
  run(h, frames);

  assert.deepEqual(activities(h.events), []);
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

  const working = h.events.filter(
    (e) => e.kind === "task" && e.data.status?.state === TaskState.TASK_STATE_WORKING,
  );
  assert.equal(working.length, 1, "exactly one working task for the coalesced turn");
  assert.ok(working[0]?.kind === "task");
  assert.equal(working[0].data.id, "task-1");
  // The folded send's own call gets a completed acknowledgment pointing at
  // the task that carries the answer.
  const acks = h.events.filter(
    (e) => e.kind === "task" && e.data.status?.state === TaskState.TASK_STATE_COMPLETED,
  );
  assert.equal(acks.length, 1);
  assert.ok(acks[0]?.kind === "task");
  assert.equal(acks[0].data.id, "task-2");
  assert.equal(acks[0].data.metadata?.[META_FOLDED_INTO], "task-1");

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

test("a send racing the queue census is not mis-folded; its turn still answers", () => {
  // Live-observed race: send B is written to stdin while turn A runs, but
  // turn A's result snapshots queued_turn_count=0 before B enters the
  // CLI's queue. B must NOT be folded into A — its own turn follows.
  const h = harness();
  h.translator.registerSend(send("send-a", 1));

  const [init, assistantA, resultA] = loadFixture("plain-turn");
  h.translator.handleFrame(init!);
  h.translator.handleFrame(assistantA!); // turn A opens here
  // B arrives mid-turn: registered after turn A opened.
  h.translator.registerSend(send("send-b", 2));
  h.translator.handleFrame(resultA!); // queued_turn_count: 0 — stale census

  const foldedAcks = h.events.filter(
    (e) => e.kind === "task" && e.data.metadata?.[META_FOLDED_INTO] !== undefined,
  );
  assert.equal(foldedAcks.length, 0, "B must not be acked as folded");

  // The CLI then runs B's turn for real; it must bind and emit.
  const frames = loadFixture("plain-turn").map((frame) =>
    "user_message_uuid" in frame && frame.user_message_uuid !== undefined
      ? { ...frame, user_message_uuid: "send-b" }
      : frame,
  ) as typeof init[];
  h.translator.handleFrame(frames[1]!);
  h.translator.handleFrame(frames[2]!);

  const tasksB = h.events.filter((e) => e.kind === "task" && e.data.id === "task-2");
  assert.equal(tasksB.length, 1, "turn B announced its task");
  const terminals = h.events.filter(
    (e) => e.kind === "statusUpdate" && e.data.taskId === "task-2",
  );
  assert.equal(terminals.length, 1, "turn B reached terminal");
  assert.deepEqual(h.warnings, [], "no dropped frames");
});

// -------------------------------------------------------------- accounting

import type { TurnAccounting } from "./translator.js";
import { META_TRIGGER } from "./types.js";

function accountingHarness(): Harness & { records: TurnAccounting[] } {
  const records: TurnAccounting[] = [];
  const events: AgentExecutionEvent[] = [];
  const warnings: string[] = [];
  const translator = new TurnTranslator({
    publish: (event) => events.push(event),
    now: () => "2026-08-26T00:00:00.000Z",
    onWarning: (message) => warnings.push(message),
    onTurnResult: (record) => records.push(record),
  });
  return { events, translator, warnings, records };
}

function initFrame(): SDKMessage {
  return { type: "system", subtype: "init", capabilities: [] } as unknown as SDKMessage;
}

function resultFrame(
  uuid: string,
  totals: { cost: number; input: number; output: number },
  extra: Record<string, unknown> = {},
): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 500,
    duration_api_ms: 400,
    is_error: false,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: totals.cost,
    usage: { input_tokens: totals.input, output_tokens: totals.output },
    modelUsage: {},
    permission_denials: [],
    user_message_uuid: uuid,
    uuid: `result-${uuid}`,
    session_id: "s1",
    ...extra,
  } as unknown as SDKMessage;
}

test("a completed turn is accounted with tools, cost, and duration", () => {
  const h = accountingHarness();
  h.translator.registerSend(send("send-tool", 1));
  run(h, loadFixture("tool-use-turn"));

  assert.equal(h.records.length, 1);
  const record = h.records[0]!;
  assert.equal(record.taskId, "task-1");
  assert.equal(record.state, "completed");
  assert.equal(record.trigger, "human");
  assert.deepEqual(record.toolsUsed, ["Bash"]);
  assert.ok(record.costUsd > 0, `cost recorded (${record.costUsd})`);
  assert.ok(record.durationMs > 0);
});

test("cumulative session totals become per-turn deltas, resetting on a new generation", () => {
  const h = accountingHarness();
  h.translator.handleFrame(initFrame());
  // Sends interleave with results, as the executor actually does; two
  // sends registered up front would read as one coalesced turn.
  h.translator.registerSend(send("u1", 1));
  h.translator.handleFrame(resultFrame("u1", { cost: 0.05, input: 100, output: 50 }));
  h.translator.registerSend(send("u2", 2));
  h.translator.handleFrame(resultFrame("u2", { cost: 0.08, input: 160, output: 90 }));

  assert.equal(h.records[0]?.costUsd.toFixed(3), "0.050");
  assert.equal(h.records[1]?.costUsd.toFixed(3), "0.030", "second turn costs the delta");
  assert.equal(h.records[1]?.inputTokens, 60);
  assert.equal(h.records[1]?.outputTokens, 40);

  // New subprocess generation: totals start over.
  h.translator.registerSend(send("u3", 3));
  h.translator.handleFrame(initFrame());
  h.translator.handleFrame(resultFrame("u3", { cost: 0.02, input: 30, output: 10 }));
  assert.equal(h.records[2]?.costUsd.toFixed(3), "0.020");
  assert.equal(h.records[2]?.inputTokens, 30);
});

test("denials and errors are recorded; the trigger comes from message metadata", () => {
  const h = accountingHarness();
  h.translator.registerSend({
    uuid: "u1",
    messageId: "m1",
    taskId: "task-1",
    contextId: "ctx-1",
    message: {
      messageId: "m1",
      contextId: "ctx-1",
      taskId: "",
      role: 1,
      parts: [],
      metadata: { [META_TRIGGER]: "routine" },
      extensions: [],
      referenceTaskIds: [],
    },
  });
  h.translator.handleFrame(
    resultFrame(
      "u1",
      { cost: 0.01, input: 5, output: 5 },
      {
        subtype: "error_during_execution",
        is_error: true,
        errors: ["budget exceeded"],
        permission_denials: [{ tool_name: "Bash", tool_use_id: "t1", tool_input: {} }],
      },
    ),
  );

  const record = h.records[0]!;
  assert.equal(record.state, "failed");
  assert.equal(record.trigger, "routine");
  assert.deepEqual(record.permissionDenials, ["Bash"]);
  assert.equal(record.error, "budget exceeded");
});

test("a turn that never sees a result still leaves a failed record", () => {
  const h = accountingHarness();
  h.translator.registerSend(send("send-a", 1));
  run(h, loadFixture("no-result")); // run() ends the stream

  assert.equal(h.records.length, 1);
  assert.equal(h.records[0]?.state, "failed");
  assert.equal(h.records[0]?.costUsd, 0);
  assert.match(h.records[0]?.error ?? "", /ended without a result/);
});

test("a throwing accounting sink warns and never fails the turn", () => {
  const events: AgentExecutionEvent[] = [];
  const warnings: string[] = [];
  const translator = new TurnTranslator({
    publish: (event) => events.push(event),
    onWarning: (message) => warnings.push(message),
    onTurnResult: () => {
      throw new Error("disk full");
    },
  });
  translator.registerSend(send("send-a", 1));
  for (const frame of loadFixture("plain-turn")) {
    translator.handleFrame(frame);
  }
  const updates = events.filter((e) => e.kind === "statusUpdate");
  assert.ok(updates.length > 0, "terminal status still emitted");
  assert.ok(warnings.some((w) => w.includes("accounting sink failed")));
});
