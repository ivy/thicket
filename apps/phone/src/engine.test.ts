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

  /** What getTask answers, by task id. */
  tasks = new Map<string, Task>();
  lookups: string[] = [];
  async getTask(taskId: string): Promise<Task> {
    this.lookups.push(taskId);
    const t = this.tasks.get(taskId);
    if (t === undefined) throw new Error(`no task ${taskId}`);
    return t;
  }

  resubscribes: string[] = [];
  resubscribeEvents: A2AEvent[] = [];
  async *resubscribe(taskId: string): AsyncIterable<A2AEvent> {
    this.resubscribes.push(taskId);
    for (const e of this.resubscribeEvents) yield e;
  }
}

function taskIn(id: string, contextId: string, state: TaskState, text = ""): Task {
  return {
    id,
    contextId,
    status: { state, message: undefined, timestamp: "t" },
    artifacts: text === "" ? [] : [{ artifactId: "reply", name: "", description: "", parts: [{ content: { $case: "text", value: text }, mediaType: "text/plain", filename: "", metadata: {} }], metadata: {}, extensions: [] }],
    history: [],
    metadata: {},
  };
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

/** A lockout port with the registry's arithmetic in miniature: N final failures lock for an hour. */
class FakeLockout {
  failures = new Map<string, number>();
  locked = new Map<string, number>();
  constructor(private readonly limit: number, private readonly clock: () => number) {}
  lockedUntil(from: string): number | undefined {
    const until = this.locked.get(from);
    return until !== undefined && until > this.clock() ? until : undefined;
  }
  failedCall(from: string): number | undefined {
    const n = (this.failures.get(from) ?? 0) + 1;
    this.failures.set(from, n);
    if (n < this.limit) return undefined;
    const until = this.clock() + 3_600_000;
    this.locked.set(from, until);
    this.failures.delete(from);
    return until;
  }
}

function harness(options: { state?: MemoryPhoneState; now?: number; maxPinAttempts?: number; lockout?: FakeLockout } = {}) {
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
    lockout: options.lockout,
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

test("a number that keeps failing is locked out: refused before the PIN, with the alert saying so", async () => {
  const now = Date.parse("2026-08-30T10:00:00Z");
  const lockout = new FakeLockout(2, () => now);
  const wrong = "11111111".split("").map((digit): CallEvent => ({ kind: "key", digit }));

  // Two calls that each burn their three attempts.
  for (const round of [1, 2]) {
    const h = harness({ lockout, now });
    await h.engine.handle(DIAL_IN[0]!);
    await h.feed(wrong);
    await h.feed(wrong);
    await h.feed(wrong);
    assert.equal(h.engine.state, "ending");
    const kinds = h.alerts.map((a) => a.kind);
    if (round === 1) {
      assert.deepEqual(kinds, ["auth_failed", "auth_failed", "auth_failed"]);
    } else {
      assert.deepEqual(kinds, ["auth_failed", "auth_failed", "auth_failed", "locked_out"]);
      const locked = h.alerts.at(-1);
      assert.ok(locked?.kind === "locked_out" && locked.untilMs === now + 3_600_000);
    }
  }

  // The third call is refused before a digit is read, and says why.
  const third = harness({ lockout, now: now + 60_000 });
  await third.engine.handle(DIAL_IN[0]!);
  assert.equal(third.engine.state, "ending");
  assert.deepEqual(third.commands, [{ type: "end", handoffData: "locked-out" }]);
  const rejected = third.alerts[0];
  assert.ok(rejected?.kind === "caller_rejected" && rejected.reason === "locked" && rejected.untilMs === now + 3_600_000);
  await third.feed(DIAL_IN.slice(1));
  assert.equal(third.texts().length, 0, "keys after the refusal do nothing");

  // After the cooldown, the number is a listed caller again.
  const afterCooldown = new FakeLockout(2, () => now + 3_600_001);
  afterCooldown.locked = new Map(lockout.locked);
  const later = harness({ lockout: afterCooldown, now: now + 3_600_001 });
  await later.feed(DIAL_IN);
  assert.equal(later.engine.state, "choosing");
});

test("the PIN is in no alert, command, or agent message — only the digits' count ever leaves the engine", async () => {
  const h = harness();
  await connectedTo(h);
  const ctx = phoneSessionId("hearth", CALL_SID);
  h.client.script([task("t1", ctx), chunk("t1", "Sure."), done("t1", ctx)]);
  await h.engine.handle(h.speech("what did I just key in"));
  await h.engine.idle();
  const everything = JSON.stringify({ alerts: h.alerts, commands: h.commands, messages: h.client.streamed, warnings: h.warnings });
  assert.doesNotMatch(everything, new RegExp(PIN));
  assert.doesNotMatch(everything, /4 ?7 ?2 ?9 ?0 ?1 ?3 ?8/);
});

test("an unlisted caller is dropped without a word", async () => {
  const h = harness();
  await h.engine.handle({ ...(DIAL_IN[0] as Extract<CallEvent, { kind: "setup" }>), from: "+15550100009" });
  assert.equal(h.engine.state, "ending");
  assert.deepEqual(h.commands, [{ type: "end", handoffData: "rejected" }]);
  assert.ok(h.alerts[0]?.kind === "caller_rejected" && h.alerts[0].reason === "unlisted");
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

test("a name is routed when said, asked about when nearly said, and asked again when unknown", async () => {
  const h = harness();
  await h.feed(DIAL_IN);
  await h.engine.handle(h.speech("Could you get me the workshop one?"));
  assert.equal(h.engine.state, "choosing");
  assert.deepEqual(h.texts().at(-1), ["I didn't catch that. Who would you like? Hearth, or Forge.", true]);

  await h.engine.handle(h.speech("Hurth"));
  assert.equal(h.engine.state, "choosing", "a near miss is never routed");
  assert.deepEqual(h.texts().at(-1), ["Did you say Hearth?", true]);
  await h.engine.handle(h.speech("no"));
  assert.equal(h.engine.state, "choosing");
  assert.deepEqual(h.texts().at(-1), ["Who would you like? Hearth, or Forge.", true]);

  await h.engine.handle(h.speech("Forj"));
  assert.deepEqual(h.texts().at(-1), ["Did you say Forge?", true]);
  await h.engine.handle(h.speech("yes"));
  assert.equal(h.engine.state, "connected");
  assert.deepEqual(h.texts().at(-1), ["Connected to Forge.", true]);
  assert.equal(h.client.streamed.length, 0, "nothing reached an agent during the exchange");
});

test("hanging up mid-task and calling back offers the session; resuming re-attaches and speaks the rest", async () => {
  const state = new MemoryPhoneState();
  const first = harness({ state });
  await connectedTo(first);
  const ctx = phoneSessionId("hearth", CALL_SID);
  const stream = first.client.open();
  await first.engine.handle(first.speech("check the disks"));
  stream.push(task("t1", ctx));
  stream.push(chunk("t1", "Checking "));
  stream.push(chunk("t1", "the disks. "));
  await settle(() => first.texts().some(([token]) => token === "Checking "));
  first.tick(30_000);
  await first.engine.hangup(); // the call drops with t1 still running
  stream.close();
  assert.equal(state.sessionFor("hearth")?.runningTaskId, "t1");

  const second = harness({ state, now: Date.parse("2026-08-30T10:03:00Z") });
  second.client.tasks.set("t1", taskIn("t1", ctx, TaskState.TASK_STATE_WORKING));
  await second.feed(DIAL_IN);
  await second.engine.handle(second.speech("hearth"));
  assert.deepEqual(second.texts().at(-1), [
    "You were talking to Hearth 3 minutes ago. It's still working on what you asked. Resume, or start fresh?",
    true,
  ]);
  second.client.resubscribeEvents = [chunk("t1", "Disks are "), chunk("t1", "fine."), done("t1", ctx)];
  await second.engine.handle(second.speech("resume"));
  await second.engine.idle();
  assert.equal(second.engine.state, "connected");
  assert.deepEqual(second.client.resubscribes, ["t1"]);
  assert.deepEqual(second.texts().slice(-3), [
    ["It's still working. Here's the rest as it comes.", true],
    ["Disks are ", false],
    ["fine.", true],
  ]);
  // The conversation continues on the same context, on the new call's message ids.
  second.client.script([task("t2", ctx), chunk("t2", "Anything else?"), done("t2", ctx)]);
  await second.engine.handle(second.speech("thanks"));
  await second.engine.idle();
  assert.equal(second.client.streamed[0]?.contextId, ctx);
  assert.equal(second.client.streamed[0]?.messageId, phoneMessageId(CALL_SID, 2));
});

test("a task that finished while the operator was away is spoken on resume, and again on request", async () => {
  const state = new MemoryPhoneState();
  state.saveSession({ agent: "hearth", contextId: "ctx-old", openedByCall: "CA-old", lastActiveAt: Date.parse("2026-08-30T09:50:00Z"), runningTaskId: "t1" });
  const h = harness({ state });
  h.client.tasks.set("t1", taskIn("t1", "ctx-old", TaskState.TASK_STATE_COMPLETED, "The backup finished and took four minutes."));
  await h.feed(DIAL_IN);
  await h.engine.handle(h.speech("home"));
  assert.match(h.texts().at(-1)![0] as string, /It finished what you asked while you were away\. Resume, or start fresh\?$/);
  await h.engine.handle(h.speech("carry on"));
  assert.deepEqual(h.texts().slice(-2), [
    ["Resuming with Hearth.", true],
    ["While you were away, it finished: The backup finished and took four minutes.", true],
  ]);
  assert.deepEqual(h.client.resubscribes, [], "a finished task is read, not re-attached");
  await h.engine.handle(h.speech("what did I miss"));
  assert.deepEqual(h.texts().at(-1), ["While you were away, it finished: The backup finished and took four minutes.", true]);
  assert.equal(h.client.streamed.length, 0, "answered by the bridge, not a turn");
});

test("declining the resume starts a fresh session with the same agent", async () => {
  const state = new MemoryPhoneState();
  state.saveSession({ agent: "hearth", contextId: "ctx-old", openedByCall: "CA-old", lastActiveAt: Date.parse("2026-08-30T09:59:00Z") });
  const h = harness({ state });
  await h.feed(DIAL_IN);
  await h.engine.handle(h.speech("hearth"));
  assert.match(h.texts().at(-1)![0] as string, /Resume, or start fresh\?$/);
  await h.engine.handle(h.speech("start fresh"));
  assert.equal(h.engine.state, "connected");
  assert.deepEqual(h.texts().at(-1), ["Connected to Hearth.", true]);
  const started = h.alerts.find((a) => a.kind === "session_started");
  assert.ok(started?.kind === "session_started" && !started.resumed && started.contextId === phoneSessionId("hearth", CALL_SID));
  assert.equal(state.sessionFor("hearth")?.contextId, phoneSessionId("hearth", CALL_SID), "the old session is superseded");
  assert.notEqual(state.sessionFor("hearth")?.contextId, "ctx-old");
});

test("switching agents by name mid-call ends one session and starts the other; both are in the alerts", async () => {
  const h = harness();
  await connectedTo(h);
  h.tick(45_000);
  await h.engine.handle(h.speech("put me through to Forge"));
  assert.equal(h.engine.state, "connected");
  assert.deepEqual(h.texts().at(-1), ["Connected to Forge.", true]);
  assert.deepEqual(
    h.alerts.map((a) => (a.kind === "session_started" ? `start:${a.agent}` : a.kind === "session_ended" ? `end:${a.agent}:${a.reason}:${a.durationMs}` : a.kind)),
    ["start:hearth", "end:hearth:switched:45000", "start:forge"],
  );
  const ctxForge = phoneSessionId("forge", CALL_SID);
  h.client.script([task("t1", ctxForge), chunk("t1", "Forge here."), done("t1", ctxForge)]);
  await h.engine.handle(h.speech("hello"));
  await h.engine.idle();
  assert.equal(h.client.streamed[0]?.contextId, ctxForge);

  // A bare "switch agent" asks; a near miss is confirmed, as in the picker.
  await h.engine.handle(h.speech("switch agent"));
  assert.equal(h.engine.state, "choosing");
  assert.deepEqual(h.texts().at(-1), ["Who would you like? Hearth, or Forge.", true]);
});
