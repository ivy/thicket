import test from "node:test";
import assert from "node:assert/strict";

import { TaskState, type Message, type Task } from "@a2a-js/sdk";
import type { A2AEvent, AgentClient } from "@thicket/a2a-client";

import { maskNumber, renderAlert, SlackAlertPoster } from "./alerts.js";
import { fixtureEvents } from "./codec.test.js";
import type { CallEvent } from "./codec.js";
import { CallEngine, type EngineLogger, type PhoneAlert } from "./engine.js";
import { MemoryPhoneState } from "./state.js";

const T = Date.parse("2026-08-30T10:00:00Z");
const PIN = "47290138";

test("numbers are masked to the country code and last four unless shown in full", () => {
  assert.equal(maskNumber("+15550100001"), "+1…0001");
  assert.equal(maskNumber("+15550100001", true), "+15550100001");
  assert.equal(maskNumber("+1555"), "…");
});

test("every alert renders as one line that says what happened and never what was said", () => {
  const from = "+15550100001";
  const lines: Array<[PhoneAlert, RegExp]> = [
    [{ kind: "session_started", callSid: "CA1", agent: "hearth", contextId: "c", resumed: false }, /started with \*hearth\* — new session, authenticated by PIN/],
    [{ kind: "session_started", callSid: "CA1", agent: "hearth", contextId: "c", resumed: true }, /— resumed/],
    [{ kind: "session_ended", callSid: "CA1", agent: "hearth", durationMs: 272_000, reason: "goodbye" }, /ended after 4m 32s — the operator said goodbye/],
    [{ kind: "session_ended", callSid: "CA1", agent: "hearth", durationMs: 5_000, reason: "dropped" }, /after 5s — call dropped/],
    [{ kind: "session_ended", callSid: "CA1", agent: "hearth", durationMs: 3_900_000, reason: "switched" }, /after 1h 5m — switched agent/],
    [{ kind: "auth_failed", callSid: "CA1", from, attempt: 1, final: false }, /PIN wrong from listed number `\+1…0001` \(attempt 1\)$/],
    [{ kind: "auth_failed", callSid: "CA1", from, attempt: 3, final: true }, /\(attempt 3, the last\) — call ended: auth failed/],
    [{ kind: "locked_out", callSid: "CA1", from, untilMs: T + 3_600_000 }, /`\+1…0001` locked out until 11:00 UTC/],
    [{ kind: "caller_rejected", callSid: "CA1", from, reason: "unlisted" }, /unlisted number `\+1…0001` refused — no session/],
    [{ kind: "caller_rejected", callSid: "CA1", from, reason: "locked", untilMs: T + 60_000 }, /refused: locked out until 10:01 UTC — no session/],
  ];
  for (const [alert, expected] of lines) {
    const text = renderAlert(alert);
    assert.match(text, expected);
    assert.doesNotMatch(text, /\n/);
    assert.doesNotMatch(text, /0100001/, "the full number never shows by default");
  }
  assert.match(renderAlert({ kind: "auth_failed", callSid: "CA1", from, attempt: 1, final: false }, { showNumbers: true }), /`\+15550100001`/);
});

function logger(): EngineLogger & { lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> } {
  const lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  return { lines, info: (msg, fields) => void lines.push({ level: "info", msg, fields }), warn: (msg, fields) => void lines.push({ level: "warn", msg, fields }) };
}

test("the poster sends chat.postMessage with the bot token, and a failure is a warning, never a throw", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let reply: () => Response = () => Response.json({ ok: true, ts: "1.2" });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply();
  }) as unknown as typeof fetch;
  const log = logger();
  const poster = new SlackAlertPoster({ channel: "C0BT7AFCMTR", botToken: "xoxb-test", logger: log, fetchImpl });

  await poster.post({ kind: "caller_rejected", callSid: "CA1", from: "+15550100009", reason: "unlisted" });
  assert.equal(calls[0]?.url, "https://slack.com/api/chat.postMessage");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer xoxb-test");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { channel: "C0BT7AFCMTR", text: renderAlert({ kind: "caller_rejected", callSid: "CA1", from: "+15550100009", reason: "unlisted" }) });
  assert.ok(log.lines.some((l) => l.msg === "alert posted" && l.fields?.ts === "1.2"));

  reply = () => Response.json({ ok: false, error: "channel_not_found" });
  await poster.post({ kind: "session_started", callSid: "CA1", agent: "hearth", contextId: "c", resumed: false });
  assert.ok(log.lines.some((l) => l.level === "warn" && l.msg === "alert post failed" && l.fields?.error === "channel_not_found"));

  reply = () => {
    throw new Error("ECONNREFUSED");
  };
  await poster.post({ kind: "session_started", callSid: "CA1", agent: "hearth", contextId: "c", resumed: false });
  assert.ok(log.lines.some((l) => l.msg === "alert post failed" && /ECONNREFUSED/.test(String(l.fields?.err))));
});

// ---------------------------------------------------------------- the counts the gate promises

class ReplyingClient implements AgentClient {
  async fetchCard() {
    return { streaming: true };
  }
  async *stream(message: Message): AsyncIterable<A2AEvent> {
    const task: Task = { id: "t1", contextId: message.contextId, status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: "t" }, artifacts: [], history: [], metadata: {} };
    yield { kind: "task", task };
    yield { kind: "artifact", taskId: "t1", text: "Done.", append: false, lastChunk: true };
    yield { kind: "status", taskId: "t1", contextId: message.contextId, state: TaskState.TASK_STATE_COMPLETED };
  }
  async send(): Promise<Task> {
    throw new Error("unused");
  }
  async cancel(): Promise<void> {}
  async *resubscribe(): AsyncIterable<A2AEvent> {}
}

function call(options: { slackDown?: boolean } = {}) {
  const posted: string[] = [];
  const log = logger();
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (options.slackDown) throw new Error("ECONNREFUSED slack.com");
    posted.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return Response.json({ ok: true, ts: String(posted.length) });
  }) as unknown as typeof fetch;
  const poster = new SlackAlertPoster({ channel: "C0BT7AFCMTR", botToken: "xoxb-test", logger: log, fetchImpl, timeoutMs: 100 });
  let now = T;
  const engine = new CallEngine({
    agents: [{ name: "hearth", spokenName: "Hearth", aliases: [], resumeWindowSeconds: 3600 }],
    clientFor: () => new ReplyingClient(),
    relay: { send: () => {} },
    state: new MemoryPhoneState(),
    alerts: poster,
    verifyPin: (digits) => digits === PIN,
    callerAllowed: (from) => from === "+15550100001",
    clock: { now: () => now },
    logger: log,
  });
  const speech = (text: string): CallEvent => ({ kind: "speech", text, final: true, lang: "en" });
  const feed = async (events: CallEvent[]) => {
    for (const e of events) await engine.handle(e);
  };
  return { engine, posted, log, speech, feed, tick: (ms: number) => void (now += ms) };
}

const DIAL_IN = fixtureEvents("dial-string-pin");

test("a successful call posts exactly two messages: start and end, with agent and duration", async () => {
  const c = call();
  await c.feed(DIAL_IN);
  await c.engine.handle(c.speech("hearth"));
  await c.engine.handle(c.speech("note the oil"));
  await c.engine.idle();
  c.tick(95_000);
  await c.engine.handle(c.speech("goodbye"));
  assert.equal(c.posted.length, 2);
  assert.match(c.posted[0]!, /session started with \*hearth\* — new session/);
  assert.match(c.posted[1]!, /session with \*hearth\* ended after 1m 35s — the operator said goodbye/);
  assert.doesNotMatch(c.posted.join("\n"), /oil|Done/, "nothing about the call's content");
});

test("three wrong PINs post three alerts, and the third says the call ended: auth failed", async () => {
  const c = call();
  await c.engine.handle(DIAL_IN[0]!);
  const wrong = "11111111".split("").map((digit): CallEvent => ({ kind: "key", digit }));
  await c.feed(wrong);
  await c.feed(wrong);
  await c.feed(wrong);
  assert.equal(c.posted.length, 3);
  assert.match(c.posted[0]!, /attempt 1\)$/);
  assert.match(c.posted[2]!, /attempt 3, the last\) — call ended: auth failed/);
  assert.equal(c.engine.state, "ending");
});

test("a call from an unlisted number posts one alert and opens no session", async () => {
  const c = call();
  await c.engine.handle({ ...(DIAL_IN[0] as Extract<CallEvent, { kind: "setup" }>), from: "+15550100009" });
  await c.feed(DIAL_IN.slice(1));
  assert.deepEqual(c.posted.length, 1);
  assert.match(c.posted[0]!, /unlisted number `\+1…0009` refused — no session/);
  assert.equal(c.engine.state, "ending");
});

test("with Slack unreachable the call proceeds normally and the log shows the failed posts", async () => {
  const c = call({ slackDown: true });
  await c.feed(DIAL_IN);
  assert.equal(c.engine.state, "choosing");
  await c.engine.handle(c.speech("hearth"));
  assert.equal(c.engine.state, "connected");
  await c.engine.handle(c.speech("carry on"));
  await c.engine.idle();
  await c.engine.handle(c.speech("goodbye"));
  assert.equal(c.engine.state, "ending");
  assert.equal(c.posted.length, 0);
  const failed = c.log.lines.filter((l) => l.msg === "alert post failed");
  assert.deepEqual(failed.map((l) => l.fields?.kind), ["session_started", "session_ended"]);
  assert.ok(!c.log.lines.some((l) => l.msg === "alert not posted"), "the poster swallows its own failures; the engine never sees a throw");
});
