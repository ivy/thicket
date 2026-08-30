import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskState } from "@a2a-js/sdk";

import { startAgent, until } from "./harness.js";
import {
  FakeRelay,
  fixtureFrames,
  ofType,
  PIN,
  postWebhook,
  promptFrame,
  setupFrame,
  startPhone,
  type RunningPhone,
} from "./phone-harness.js";

// The spike's recordings, as Twilio sent them. Every scenario opens with the
// dial-string call: setup, then the eight digits keyed one second after connect.
const DIAL_STRING = fixtureFrames("dial-string-pin");
const KEYS = ofType(DIAL_STRING, "dtmf");
const SPOKEN = ofType(fixtureFrames("pin-spoken"), "prompt");
const INTERRUPT = ofType(fixtureFrames("interrupt"), "interrupt")[0]!.frame;
const CALL_SID = String(setupFrame().callSid);

function wrongPin(): Array<{ ms: number; frame: Record<string, unknown> }> {
  return "11111111".split("").map((digit, i) => ({ ms: i * 380, frame: { type: "dtmf", digit } }));
}

async function connected(relay: FakeRelay): Promise<void> {
  await relay.play(DIAL_STRING);
  await until(() => relay.utterances().length >= 1, "Aiva's hello");
  relay.send(promptFrame("Hearth."));
  await until(() => relay.utterances().some((u) => /Connected to Hearth|Resuming with Hearth/.test(u)), "connected");
}

async function rig(t: { after(fn: () => unknown): void }, options: Parameters<typeof startPhone>[1] = {}) {
  const agent = await startAgent("hearth");
  t.after(() => agent.stop());
  const phone = await startPhone(agent, options);
  t.after(() => phone.stop());
  return { agent, phone };
}

async function relayFor(phone: RunningPhone): Promise<FakeRelay> {
  const relay = await FakeRelay.connect(phone.port);
  assert.ok(relay instanceof FakeRelay, "the signed handshake opens");
  return relay;
}

test("phone 1: the PIN keyed from the dial string opens the picker; nothing is spoken before it", async (t) => {
  const { agent, phone } = await rig(t);
  const relay = await relayFor(phone);
  relay.send(setupFrame());
  await relay.play(KEYS, 100); // the recorded 380 ms cadence, 100× faster
  await until(() => relay.utterances().length >= 1, "Aiva's hello");
  assert.deepEqual(relay.utterances(), ["Hi, it's Aiva. Shall I connect you to Hearth?"]);
  assert.equal(relay.commands()[0]?.type, "text", "the first thing sent is Aiva's hello — nothing before the eighth digit");
  assert.equal(agent.cli.turnsRun, 0, "no agent traffic");
  assert.equal(phone.registry.call(CALL_SID)?.direction, "inbound");
  relay.hangUp();
});

test("phone 2: speech before the PIN is discarded — the spoken-PIN recording opens nothing", async (t) => {
  const { agent, phone } = await rig(t);
  const relay = await relayFor(phone);
  relay.send(setupFrame("pin-spoken"));
  await relay.play(SPOKEN); // "Four seven two nine zero one three eight." and a sentence, as recorded
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(relay.commands(), [], "silence: the digits were said, not keyed");
  assert.equal(agent.cli.turnsRun, 0);
  relay.hangUp();
});

test("phone 3: three wrong PINs end the call with a spoken refusal and three alerts", async (t) => {
  const { phone } = await rig(t);
  const relay = await relayFor(phone);
  relay.send(setupFrame());
  for (let i = 0; i < 3; i += 1) await relay.play(wrongPin());
  await until(() => relay.commands().some((c) => c.type === "end"), "the end command");
  assert.deepEqual(relay.utterances(), ["That's not it. Try again.", "That's not it. Try again.", "That's not it. Goodbye."]);
  assert.deepEqual(relay.commands().at(-1), { type: "end", handoffData: "auth-failed" });
  assert.deepEqual(
    phone.alerts.map((a) => (a.kind === "auth_failed" ? [a.attempt, a.final] : a.kind)),
    [[1, false], [2, false], [3, true]],
  );
  // Twilio's follow-up records why.
  const res = await postWebhook(phone.port, "/action", { CallSid: CALL_SID, SessionStatus: "ended", HandoffData: "auth-failed" });
  assert.equal(res.status, 200);
  assert.equal(phone.registry.call(CALL_SID)?.endReason, "auth-failed");
});

test("phone 4: an unlisted caller is refused without a word, with one alert", async (t) => {
  const { phone } = await rig(t);
  const relay = await relayFor(phone);
  relay.send(setupFrame("dial-string-pin", { from: "+15550100009" }));
  await until(() => relay.commands().length >= 1, "the refusal");
  assert.deepEqual(relay.commands(), [{ type: "end", handoffData: "rejected" }]);
  assert.deepEqual(phone.alerts.map((a) => a.kind), ["caller_rejected"]);
  await relay.play(KEYS);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(relay.commands().length, 1, "keys after the refusal do nothing");
});

test("phone 5: pick an agent and task it — the recorded prompt runs a real turn and is spoken back", async (t) => {
  const { agent, phone } = await rig(t);
  const relay = await relayFor(phone);
  await connected(relay);
  assert.equal(relay.utterances().at(-1), "Connected to Hearth.");
  assert.equal(phone.registry.call(CALL_SID)?.agent, "hearth");

  const recorded = SPOKEN.filter((f) => f.frame.last === true)[1]!; // "The quick brown fox."
  relay.send(recorded.frame);
  await until(() => relay.utterances().length >= 3, "the answer");
  const answer = relay.utterances().at(-1)!;
  // The fake CLI echoes its prompt: the phone preamble reached the agent, ahead of the operator's words.
  assert.match(answer, /^answer\(You are on a voice call with the operator, who authenticated with their PIN\./);
  assert.match(answer, /The quick brown fox\.\)$/);
  assert.equal(agent.cli.turnsRun, 1);
  const [, last] = relay.texts().at(-1)!;
  assert.equal(last, true, "the final token carries last");
  assert.equal(relay.texts().filter(([, l]) => l).length, 3, "exactly one last per utterance");

  relay.send(promptFrame("Goodbye."));
  await until(() => relay.commands().some((c) => c.type === "end"), "goodbye");
  assert.deepEqual(relay.commands().at(-1), { type: "end", handoffData: "goodbye" });
  assert.deepEqual(phone.alerts.map((a) => a.kind), ["session_started", "session_ended"]);
});

test("phone 6: barge-in mid-sentence cancels the task, and no token follows the interrupt", async (t) => {
  const { agent, phone } = await rig(t);
  const relay = await relayFor(phone);
  await connected(relay);
  agent.cli.hold = true; // the turn stays open after its first words
  relay.send(promptFrame("Tell me a long story."));
  await until(() => agent.cli.turnsRun === 1, "the turn started");
  await until(() => phone.registry.call(CALL_SID) !== undefined, "registered");
  await new Promise((resolve) => setTimeout(resolve, 30)); // the task event reaches the engine

  relay.send(INTERRUPT); // the recorded barge-in: "Sentence 2 of", 684 ms in
  await until(() => agent.cli.interrupts === 1, "the agent was interrupted");
  await new Promise((resolve) => setTimeout(resolve, 30)); // the canceled status drains
  assert.deepEqual(relay.commandsAfterLast("interrupt").filter((c) => c.type === "text"), [], "nothing spoken after the interrupt");

  agent.cli.hold = false;
  relay.send(promptFrame("Never mind. What is two plus two?"));
  await until(() => agent.cli.turnsRun === 2, "a new turn");
  await until(() => relay.commandsAfterLast("prompt").some((c) => c.type === "text" && c.last), "the answer");
  const answer = relay.utterances().at(-1)!;
  assert.match(answer, /\[You were interrupted after saying: "Sentence 2 of"\] Never mind\. What is two plus two\?\)$/);
  // Frame ordering: between the barge-in and the next prompt, not one token
  // reached the wire. (The dial-string recording carries an interrupt of its
  // own — the trailing # barging in on the spike's reply — so anchor on ours.)
  const timeline = relay.timeline;
  let interruptAt = -1;
  timeline.forEach((e, i) => {
    if (e.dir === "in" && e.frame.type === "interrupt") interruptAt = i;
  });
  const nextPromptAt = timeline.findIndex((e, i) => i > interruptAt && e.dir === "in" && e.frame.type === "prompt");
  const tokensBetween = timeline.slice(interruptAt + 1, nextPromptAt).filter((e) => e.dir === "out" && e.command.type === "text");
  assert.equal(tokensBetween.length, 0);
  const canceled = timeline.slice(interruptAt + 1).filter((e) => e.dir === "out" && e.command.type === "text" && e.command.last);
  assert.equal(canceled.length, 1, "one utterance after the interrupt: the new answer, nothing from the cancelled turn");
});

test("phone 7: drop mid-task and call back — the finished task is spoken on resume", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "phone-int-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { agent, phone } = await rig(t, { dbPath: join(dir, "phone.db") });
  const relay = await relayFor(phone);
  await connected(relay);
  agent.cli.hold = true;
  relay.send(promptFrame("Check the disks."));
  await until(() => agent.cli.turnsRun === 1, "the turn started");
  await new Promise((resolve) => setTimeout(resolve, 30));
  relay.drop(); // the car went through a tunnel
  await until(() => phone.alerts.some((a) => a.kind === "session_ended" && a.reason === "dropped"), "the drop was noticed");
  const session = phone.registry.sessionFor("hearth");
  assert.ok(session?.runningTaskId, "the running task is remembered");
  agent.cli.release(); // the agent finishes while the operator is out of signal
  await new Promise((resolve) => setTimeout(resolve, 50));

  const again = await FakeRelay.connect(phone.port);
  assert.ok(again instanceof FakeRelay);
  again.send(setupFrame("dial-string-pin", { callSid: "CA00000000000000000000000000000002", sessionId: "VX2" }));
  await again.play(KEYS);
  await until(() => again.utterances().length >= 1, "Aiva's hello");
  again.send(promptFrame("Hearth."));
  await until(() => again.utterances().some((u) => /Resume, or start fresh\?$/.test(u)), "the offer");
  assert.match(again.utterances().at(-1)!, /You were talking to Hearth a minute ago\. It finished what you asked while you were away\. Resume, or start fresh\?/);
  again.send(promptFrame("Resume."));
  await until(() => again.utterances().some((u) => /While you were away, it finished:/.test(u)), "what it produced");
  assert.match(again.utterances().at(-1)!, /While you were away, it finished: answer\(/);
  const started = phone.alerts.filter((a) => a.kind === "session_started");
  assert.equal(started.length, 2);
  assert.ok(started[1]?.kind === "session_started" && started[1].resumed);
  assert.equal(started[1]?.kind === "session_started" ? started[1].contextId : "", session!.contextId, "the same session");
});

test("phone 8: the agent goes away mid-call — the failure is spoken and the call stays up", async (t) => {
  const agent = await startAgent("hearth");
  const phone = await startPhone(agent);
  t.after(() => phone.stop());
  const relay = await relayFor(phone);
  await connected(relay);
  await agent.stop(); // the host went to sleep
  relay.send(promptFrame("Are you there?"));
  await until(() => relay.utterances().some((u) => /Something went wrong talking to Hearth/.test(u)), "the failure spoken");
  assert.ok(relay.closed === undefined, "the call is still up");
  relay.send(promptFrame("Goodbye."));
  await until(() => relay.commands().some((c) => c.type === "end"), "goodbye still works");
});

test("phone 9: bridge restart with a live call — the wrap-up lands and the session survives", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "phone-int-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "phone.db");
  const agent = await startAgent("hearth");
  t.after(() => agent.stop());
  const first = await startPhone(agent, { dbPath });
  const relay = await relayFor(first);
  await connected(relay);
  const contextId = first.registry.call(CALL_SID)?.contextId;
  await first.stop(); // the bridge restarts under the call
  await until(() => relay.closed !== undefined, "the socket died with the bridge");

  const second = await startPhone(agent, { dbPath });
  t.after(() => second.stop());
  const res = await postWebhook(second.port, "/action", { CallSid: CALL_SID, SessionStatus: "failed", ErrorCode: "64105", ErrorMessage: "Websocket ended" });
  assert.equal(res.status, 200);
  assert.match(res.body, /<Hangup\/>/);
  assert.equal(second.registry.call(CALL_SID)?.endReason, "failed:64105");

  const again = await FakeRelay.connect(second.port);
  assert.ok(again instanceof FakeRelay);
  again.send(setupFrame("dial-string-pin", { callSid: "CA00000000000000000000000000000003", sessionId: "VX3" }));
  await again.play(KEYS);
  await until(() => again.utterances().length >= 1, "hello");
  again.send(promptFrame("home"));
  await until(() => again.utterances().some((u) => /Resume, or start fresh\?$/.test(u)), "the session survived the restart");
  again.send(promptFrame("resume"));
  await until(() => again.utterances().some((u) => u === "Resuming with Hearth."), "resumed");
  assert.equal(second.registry.call("CA00000000000000000000000000000003")?.contextId, contextId);
});

test("phone 10: a bad signature is refused before any frame is read", async (t) => {
  const { agent, phone } = await rig(t);
  assert.deepEqual(await FakeRelay.connect(phone.port, { signature: "nope" }), { status: 403 });
  assert.deepEqual(await FakeRelay.connect(phone.port, { signature: "" }), { status: 403 });
  assert.deepEqual(await FakeRelay.connect(phone.port, { path: "/relay/other" }), { status: 404 });
  assert.equal(agent.cli.turnsRun, 0);
  assert.ok(phone.logs.some((l) => l.msg === "handshake refused"));
  assert.ok(!phone.logs.some((l) => l.msg === "relay connected"));
});

test("phone harness sanity: the fixtures are the spike's recordings", () => {
  assert.equal(KEYS.map((k) => k.frame.digit).join(""), `${PIN}#`);
  assert.equal(INTERRUPT.utteranceUntilInterrupt, "Sentence 2 of");
  assert.ok(SPOKEN.length > 10, "partials and finals, as recorded");
  assert.equal(TaskState.TASK_STATE_COMPLETED, 3);
});
