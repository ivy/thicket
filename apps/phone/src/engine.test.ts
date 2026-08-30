import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { TaskState, type Message, type Task } from "@a2a-js/sdk";
import type { A2AEvent, AgentClient } from "@thicket/a2a-client";
import { META_PHONE_KIND, META_TRIGGER } from "@thicket/executor";
import type { PhoneAgent } from "@thicket/roster";

import { fixtureEvents } from "./codec.test.js";
import type { CallEvent, RelayCommand } from "./codec.js";
import { CallEngine, phoneMessageId, phoneSessionId, type PhoneAlert, type Scheduler } from "./engine.js";
import { MemoryPhoneState } from "./state.js";

const AGENTS: PhoneAgent[] = [
  { name: "hearth", spokenName: "Hearth", aliases: ["home"], resumeWindowSeconds: 3600 },
  { name: "forge", spokenName: "Forge", aliases: [], resumeWindowSeconds: 3600 },
];
const PIN = "47290138";

function task(id: string, contextId: string): A2AEvent {
  const t: Task = {
    id,
    contextId,
    status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: "t" },
    artifacts: [],
    history: [],
    metadata: {},
  };
  return { kind: "task", task: t };
}
const chunk = (taskId: string, text: string): A2AEvent => ({ kind: "artifact", taskId, text, append: true, lastChunk: false });
const done = (taskId: string, contextId: string, state = TaskState.TASK_STATE_COMPLETED, messageText?: string): A2AEvent => ({
  kind: "status",
  taskId,
  contextId,
  state,
  ...(messageText === undefined ? {} : { messageText }),
});

/**
 * An agent whose every stream is a queue the test feeds: events arrive when
 * the test says so, which is what an interrupt mid-turn needs.
 */
class ScriptedClient implements AgentClient {
  streamed: Message[] = [];
  cancels: string[] = [];
  cancelError?: Error;
  private queues: Array<{ events: A2AEvent[]; closed: boolean; wake: () => void }> = [];

  /** Script the next stream in full; it plays out as fast as the engine reads it. */
  script(events: A2AEvent[]): void {
    this.queues.push({ events: [...events], closed: true, wake: () => {} });
  }

  /** Open a stream the test feeds by hand. */
  open(): { push(e: A2AEvent): void; close(): void } {
    const q = { events: [] as A2AEvent[], closed: false, wake: () => {} };
    this.queues.push(q);
    return {
      push: (e) => {
        q.events.push(e);
        q.wake();
      },
      close: () => {
        q.closed = true;
        q.wake();
      },
    };
  }

  async fetchCard() {
    return { streaming: true };
  }

  stream(message: Message): AsyncIterable<A2AEvent> {
    this.streamed.push(message);
    const q = this.queues.shift();
    if (q === undefined) throw new Error("no script for this stream");
    return (async function* () {
      for (;;) {
        while (q.events.length > 0) yield q.events.shift()!;
        if (q.closed) return;
        await new Promise<void>((resolve) => (q.wake = resolve));
      }
    })();
  }

  async send(): Promise<Task> {
    throw new Error("not used");
  }

  async cancel(taskId: string): Promise<void> {
    this.cancels.push(taskId);
    if (this.cancelError) throw this.cancelError;
  }

  async *resubscribe(): AsyncIterable<A2AEvent> {}
}

class ManualScheduler implements Scheduler {
  pending: Array<() => void> = [];
  schedule(_ms: number, fn: () => void): () => void {
    this.pending.push(fn);
    return () => {
      this.pending = this.pending.filter((f) => f !== fn);
    };
  }
  fire(): void {
    const due = this.pending;
    this.pending = [];
    for (const fn of due) fn();
  }
}

function harness(options: { state?: MemoryPhoneState; now?: number; maxPinAttempts?: number } = {}) {
  const client = new ScriptedClient();
  const commands: RelayCommand[] = [];
  const alerts: PhoneAlert[] = [];
  const warnings: string[] = [];
  const scheduler = new ManualScheduler();
  let now = options.now ?? Date.parse("2026-08-30T10:00:00Z");
  const engine = new CallEngine({
    agents: AGENTS,
    clientFor: () => client,
    relay: { send: (c) => void commands.push(c) },
    state: options.state ?? new MemoryPhoneState(),
    alerts: { post: (a) => void alerts.push(a) },
    verifyPin: (digits) => digits === PIN,
    callerAllowed: (from) => from === "+15550100001",
    maxPinAttempts: options.maxPinAttempts,
    clock: { now: () => now },
    scheduler,
    logger: { info: () => {}, warn: (msg) => void warnings.push(msg) },
  });
  const texts = () => commands.filter((c) => c.type === "text").map((c) => (c.type === "text" ? [c.token, c.last] : []));
  const feed = async (events: CallEvent[]) => {
    for (const e of events) await engine.handle(e);
  };
  const speech = (text: string): CallEvent => ({ kind: "speech", text, final: true, lang: "en" });
  const tick = (ms: number) => void (now += ms);
  return { engine, client, commands, alerts, warnings, scheduler, texts, feed, speech, tick };
}

/** The call as the wire saw it: setup, then the PIN keyed from the dial string. */
const DIAL_IN = fixtureEvents("dial-string-pin");
const CALL_SID = (DIAL_IN[0] as Extract<CallEvent, { kind: "setup" }>).callSid;

async function connectedTo(h: ReturnType<typeof harness>, agent = "hearth"): Promise<void> {
  await h.feed(DIAL_IN);
  assert.equal(h.engine.state, "choosing");
  await h.engine.handle(h.speech(agent));
  assert.equal(h.engine.state, "connected");
}

test("replaying the recorded call: the PIN opens the picker, and each turn's final token alone carries last", async () => {
  const h = harness();
  await h.feed(DIAL_IN);
  assert.equal(h.engine.state, "choosing");
  assert.deepEqual(h.texts(), [["Hi, it's Aiva. Who would you like? Hearth, or Forge.", true]]);

  await h.engine.handle(h.speech("Hearth, please"));
  assert.equal(h.engine.state, "connected");
  assert.deepEqual(h.texts().at(-1), ["Connected to Hearth.", true]);
  const before = h.commands.length;

  // The two finalized prompts and their partials, as recorded.
  const ctx = phoneSessionId("hearth", CALL_SID);
  h.client.script([task("t1", ctx), chunk("t1", "Ten "), chunk("t1", "four "), chunk("t1", "again."), done("t1", ctx)]);
  h.client.script([task("t2", ctx), chunk("t2", "Fox "), chunk("t2", "noted."), done("t2", ctx)]);
  for (const e of fixtureEvents("pin-spoken").filter((e) => e.kind === "speech")) {
    await h.engine.handle(e);
    await h.engine.idle();
  }
  assert.equal(h.client.streamed.length, 2, "partials never start a turn");
  assert.deepEqual(h.texts().slice(before), [
    ["Ten ", false],
    ["four ", false],
    ["again.", true],
    ["Fox ", false],
    ["noted.", true],
  ]);

  const [m1, m2] = h.client.streamed;
  assert.equal(m1!.messageId, phoneMessageId(CALL_SID, 1));
  assert.equal(m2!.messageId, phoneMessageId(CALL_SID, 2));
  assert.equal(m1!.contextId, ctx);
  assert.equal(m2!.contextId, ctx);
  assert.equal(m1!.taskId, "", "every utterance is a new task");
  assert.equal(m1!.metadata?.[META_TRIGGER], "phone");
  assert.equal(m1!.metadata?.[META_PHONE_KIND], "speech");
  assert.deepEqual(
    h.alerts.map((a) => a.kind),
    ["session_started"],
  );
});

test("nothing reaches the agent before connected: a wrong PIN ends the call, speech is discarded", async () => {
  const h = harness();
  await h.engine.handle(DIAL_IN[0]!);
  assert.equal(h.engine.state, "authenticating");
  await h.engine.handle(h.speech("hearth, connect me to hearth"));
  assert.equal(h.commands.length, 0, "silence before authentication");

  const wrong = "11111111".split("").map((digit): CallEvent => ({ kind: "key", digit }));
  await h.feed(wrong);
  await h.feed(wrong);
  assert.deepEqual(h.texts(), [
    ["That's not it. Try again.", true],
    ["That's not it. Try again.", true],
  ]);
  await h.feed(wrong);
  assert.equal(h.engine.state, "ending");
  assert.deepEqual(h.commands.at(-1), { type: "end", handoffData: "auth-failed" });
  assert.deepEqual(
    h.alerts.map((a) => (a.kind === "auth_failed" ? [a.attempt, a.final] : a.kind)),
    [[1, false], [2, false], [3, true]],
  );
  await h.engine.handle(h.speech("hello?"));
  assert.equal(h.client.streamed.length, 0);
  assert.equal(h.client.cancels.length, 0);
});

test("an unlisted caller is dropped without a word", async () => {
  const h = harness();
  await h.engine.handle({ ...(DIAL_IN[0] as Extract<CallEvent, { kind: "setup" }>), from: "+15550100009" });
  assert.equal(h.engine.state, "ending");
  assert.deepEqual(h.commands, [{ type: "end", handoffData: "rejected" }]);
  assert.equal(h.alerts[0]?.kind, "caller_rejected");
});

test("an interrupt mid-turn cancels the task, forwards nothing more, and the next prompt is a new task in the same context", async () => {
  const h = harness();
  await connectedTo(h);
  const ctx = phoneSessionId("hearth", CALL_SID);
  const before = h.commands.length;

  const stream = h.client.open();
  await h.engine.handle(h.speech("tell me a story"));
  stream.push(task("t1", ctx));
  stream.push(chunk("t1", "Sentence one. "));
  stream.push(chunk("t1", "Sentence two. "));
  await settle(() => h.commands.length > before);
  assert.deepEqual(h.texts().slice(before), [["Sentence one. ", false]]);

  const interrupt = fixtureEvents("interrupt").find((e) => e.kind === "interrupt")!;
  await h.engine.handle(interrupt);
  assert.deepEqual(h.client.cancels, ["t1"]);
  stream.push(chunk("t1", "Sentence three. "));
  stream.push(done("t1", ctx, TaskState.TASK_STATE_CANCELED));
  stream.close();
  await h.engine.idle();
  assert.deepEqual(h.texts().slice(before), [["Sentence one. ", false]], "the held chunk and everything after it are dropped");

  h.client.script([task("t2", ctx), chunk("t2", "Go on it is."), done("t2", ctx)]);
  await h.engine.handle(h.speech("go on"));
  await h.engine.idle();
  const next = h.client.streamed[1]!;
  assert.equal(next.contextId, ctx);
  assert.equal(next.taskId, "");
  assert.equal(next.metadata?.[META_PHONE_KIND], "interrupted");
  assert.equal(next.parts[0]?.content?.value, '[You were interrupted after saying: "Sentence 2 of"] go on');
  assert.deepEqual(h.texts().at(-1), ["Go on it is.", true]);
});

test("a cancel that races the turn's natural end is not an error", async () => {
  const h = harness();
  await connectedTo(h);
  const ctx = phoneSessionId("hearth", CALL_SID);

  // The turn is over before the interrupt lands: nothing to cancel, nothing thrown.
  h.client.script([task("t1", ctx), chunk("t1", "Done."), done("t1", ctx)]);
  await h.engine.handle(h.speech("quick one"));
  await h.engine.idle();
  await h.engine.handle({ kind: "interrupt", heard: "Done.", afterMs: 100 });
  assert.deepEqual(h.client.cancels, []);

  // The agent finishes while our cancel is in flight and rejects it: logged, not raised.
  const stream = h.client.open();
  h.client.cancelError = new Error("task t2 is already terminal");
  await h.engine.handle(h.speech("another"));
  stream.push(task("t2", ctx));
  stream.push(chunk("t2", "First "));
  stream.push(chunk("t2", "second "));
  await settle(() => h.texts().some(([token]) => token === "First "));
  await h.engine.handle({ kind: "interrupt", heard: "First", afterMs: 50 });
  stream.push(done("t2", ctx));
  stream.close();
  await h.engine.idle();
  assert.deepEqual(h.client.cancels, ["t2"]);
  assert.ok(h.warnings.some((w) => /cancel after the turn ended/.test(w)));
  assert.equal(h.engine.state, "connected");
  assert.ok(!h.texts().some(([token]) => token === "second "), "nothing after the interrupt");
});

test("keypresses batch into one message; control phrases never start a turn", async () => {
  const h = harness();
  await connectedTo(h);
  const ctx = phoneSessionId("hearth", CALL_SID);
  for (const digit of ["1", "2", "3"]) await h.engine.handle({ kind: "key", digit });
  assert.equal(h.client.streamed.length, 0);
  h.client.script([task("t1", ctx), chunk("t1", "Option one two three."), done("t1", ctx)]);
  h.scheduler.fire();
  await h.engine.idle();
  assert.equal(h.client.streamed.length, 1);
  assert.equal(h.client.streamed[0]?.parts[0]?.content?.value, "123");
  assert.equal(h.client.streamed[0]?.metadata?.[META_PHONE_KIND], "dtmf");

  await h.engine.handle(h.speech("Repeat that."));
  assert.deepEqual(h.texts().at(-1), ["Option one two three.", true]);
  await h.engine.handle(h.speech("Status?"));
  assert.deepEqual(h.texts().at(-1), ["Nothing is running.", true]);
  assert.equal(h.client.streamed.length, 1, "no turn for a control phrase");

  await h.engine.handle(h.speech("Goodbye."));
  assert.equal(h.engine.state, "ending");
  assert.deepEqual(h.commands.at(-1), { type: "end", handoffData: "goodbye" });
  assert.equal(h.alerts.at(-1)?.kind, "session_ended");
});

test("a session outlives the call: the next call is offered it back, on the same contextId", async () => {
  const state = new MemoryPhoneState();
  const first = harness({ state });
  await connectedTo(first);
  const ctx = phoneSessionId("hearth", CALL_SID);
  first.tick(90_000);
  await first.engine.hangup();
  const ended = first.alerts.at(-1);
  assert.ok(ended?.kind === "session_ended" && ended.durationMs === 90_000);
  assert.equal(state.sessionFor("hearth")?.contextId, ctx);

  const second = harness({ state, now: Date.parse("2026-08-30T10:05:00Z") });
  await second.feed(DIAL_IN);
  await second.engine.handle(second.speech("home"));
  assert.equal(second.engine.state, "choosing");
  assert.deepEqual(second.texts().at(-1), ["You were talking to Hearth 4 minutes ago. Resume, or start fresh?", true]);
  await second.engine.handle(second.speech("resume"));
  assert.equal(second.engine.state, "connected");
  assert.deepEqual(second.texts().at(-1), ["Resuming with Hearth.", true]);
  const started = second.alerts.find((a) => a.kind === "session_started");
  assert.ok(started?.kind === "session_started" && started.resumed);

  second.client.script([task("t9", ctx), chunk("t9", "Still here."), done("t9", ctx)]);
  await second.engine.handle(second.speech("where were we"));
  await second.engine.idle();
  assert.equal(second.client.streamed[0]?.contextId, ctx, "the same session, from a different call");
  assert.equal(second.client.streamed[0]?.messageId, phoneMessageId(CALL_SID, 1));

  // Past the window, the session is not offered.
  const third = harness({ state, now: Date.parse("2026-08-30T12:00:00Z") });
  await third.feed(DIAL_IN);
  await third.engine.handle(third.speech("hearth"));
  assert.equal(third.engine.state, "connected");
  assert.notEqual(third.client, undefined);
});

test("nothing outside the codec spells a Twilio message shape", () => {
  // Twilio's field names and wire types; the engine's own event kinds
  // ("setup", "interrupt") are the codec's vocabulary, not Twilio's shape.
  const twilio = /voicePrompt|utteranceUntilInterrupt|durationUntilInterruptMs|handoffData|sendDigits|customParameters|tokensPlayed|agentSpeaking|clientSpeaking|"prompt"|type: "/;
  for (const file of ["engine.ts", "state.ts", "config.ts", "index.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, twilio, `${file} names a Twilio shape`);
  }
});

async function settle(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (cond()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never held");
}
