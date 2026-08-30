import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

import WebSocket from "ws";
import { TaskState, type Message, type Task } from "@a2a-js/sdk";
import type { A2AEvent, AgentClient } from "@thicket/a2a-client";

import type { RelayCommand } from "./codec.js";
import { CallEngine, type EngineLogger, type PhoneAlert } from "./engine.js";
import { run } from "./main.js";
import { CallRegistry } from "./registry.js";
import { buildPhoneServer, type PhoneServer } from "./server.js";
import { twilioSignature } from "./signature.js";

const PUBLIC = "https://phone.example.net";
const TOKEN = "auth-token-for-tests";
const SECRET = "fixture";
const PIN = "47290138";
const CALL = {
  type: "setup",
  sessionId: "VX1",
  callSid: "CA00000000000000000000000000000001",
  parentCallSid: "",
  from: "+15550100001",
  to: "+15550100002",
  forwardedFrom: "",
  callerName: "",
  direction: "inbound",
  callType: "PSTN",
  callStatus: "RINGING",
  accountSid: "AC" + "0".repeat(32),
  customParameters: {},
};

class QuietClient implements AgentClient {
  streamed: Message[] = [];
  async fetchCard() {
    return { streaming: true };
  }
  async *stream(message: Message): AsyncIterable<A2AEvent> {
    this.streamed.push(message);
    const task: Task = {
      id: "t1",
      contextId: message.contextId,
      status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: "t" },
      artifacts: [],
      history: [],
      metadata: {},
    };
    yield { kind: "task", task };
    yield { kind: "artifact", taskId: "t1", text: "Noted.", append: false, lastChunk: true };
    yield { kind: "status", taskId: "t1", contextId: message.contextId, state: TaskState.TASK_STATE_COMPLETED };
  }
  async send(): Promise<Task> {
    throw new Error("unused");
  }
  async cancel(): Promise<void> {}
  async *resubscribe(): AsyncIterable<A2AEvent> {}
}

function collectingLogger(): EngineLogger & { lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> } {
  const lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  return {
    lines,
    info: (msg, fields) => void lines.push({ level: "info", msg, fields }),
    warn: (msg, fields) => void lines.push({ level: "warn", msg, fields }),
  };
}

async function startServer(registry: CallRegistry) {
  const logger = collectingLogger();
  const alerts: PhoneAlert[] = [];
  const client = new QuietClient();
  let engines = 0;
  const phone: PhoneServer = buildPhoneServer({
    publicBaseUrl: PUBLIC,
    authToken: TOKEN,
    registry,
    relaySecret: SECRET,
    logger,
    alerts: { post: (a) => void alerts.push(a) },
    engineFor: (relay, engineAlerts) => {
      engines += 1;
      return new CallEngine({
        agents: [{ name: "hearth", spokenName: "Hearth", aliases: [], resumeWindowSeconds: 3600 }],
        clientFor: () => client,
        relay,
        state: registry,
        alerts: engineAlerts,
        verifyPin: (digits) => digits === PIN,
        callerAllowed: (from) => from === "+15550100001",
        logger,
      });
    },
  });
  await new Promise<void>((resolve) => phone.server.listen(0, "127.0.0.1", () => resolve()));
  const address = phone.server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  const port = address.port;
  return { phone, port, logger, alerts, client, engineCount: () => engines };
}

function connect(port: number, headers: Record<string, string>, path = `/relay/${SECRET}`) {
  return new Promise<{ ws?: WebSocket; status?: number }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.on("open", () => resolve({ ws }));
    ws.on("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode });
      ws.terminate();
    });
    ws.on("error", () => resolve({}));
  });
}

function post(port: number, path: string, form: Record<string, string>, sign = true) {
  const body = new URLSearchParams(form).toString();
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) };
  if (sign) headers["x-twilio-signature"] = twilioSignature(TOKEN, `${PUBLIC}${path}`, form);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function received(ws: WebSocket): RelayCommand[] {
  return (ws as WebSocket & { got: RelayCommand[] }).got;
}

function record(ws: WebSocket): void {
  const got: RelayCommand[] = [];
  (ws as WebSocket & { got: RelayCommand[] }).got = got;
  ws.on("message", (data) => got.push(JSON.parse(data.toString()) as RelayCommand));
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out: ${what}`);
}

test("a handshake with a bad or missing signature is refused before any frame is read", async (t) => {
  const registry = new CallRegistry(":memory:");
  const s = await startServer(registry);
  t.after(() => s.phone.close());

  assert.equal((await connect(s.port, {})).status, 403, "no signature");
  assert.equal((await connect(s.port, { "x-twilio-signature": "nope" })).status, 403, "bad signature");
  assert.equal((await connect(s.port, { "x-twilio-signature": twilioSignature(TOKEN, `wss://phone.example.net/relay/other`) }, "/relay/other")).status, 404);
  assert.equal(s.engineCount(), 0, "no engine, so no frame could have been read");
  assert.ok(s.logger.lines.some((l) => l.msg === "handshake refused" && l.fields?.signature === "missing"));

  const good = await connect(s.port, { "x-twilio-signature": twilioSignature(TOKEN, `wss://phone.example.net/relay/${SECRET}`) });
  assert.ok(good.ws, "the right signature opens");
  assert.equal(s.engineCount(), 1);
  good.ws!.close();
});

test("goodbye ends the relay session, and the signed follow-up webhook records why and hangs up", async (t) => {
  const registry = new CallRegistry(":memory:");
  const s = await startServer(registry);
  t.after(() => s.phone.close());
  const { ws } = await connect(s.port, { "x-twilio-signature": twilioSignature(TOKEN, `wss://phone.example.net/relay/${SECRET}`) });
  record(ws!);

  ws!.send(JSON.stringify(CALL));
  for (const digit of PIN) ws!.send(JSON.stringify({ type: "dtmf", digit }));
  await until(() => received(ws!).length >= 1, "the picker");
  assert.equal(registry.call(CALL.callSid)?.direction, "inbound", "setup recorded the call");

  ws!.send(JSON.stringify({ type: "prompt", voicePrompt: "Hearth.", lang: "en", last: true }));
  await until(() => received(ws!).length >= 2, "connected");
  assert.equal(registry.call(CALL.callSid)?.agent, "hearth", "the session_started alert attached the agent");
  assert.ok(registry.call(CALL.callSid)?.contextId);
  ws!.send(JSON.stringify({ type: "prompt", voicePrompt: "Note that the car needs oil.", lang: "en", last: true }));
  await until(() => received(ws!).some((c) => c.type === "text" && c.token === "Noted."), "the agent's reply");

  // A switch mid-call: the call log keeps both sessions.
  ws!.send(JSON.stringify({ type: "prompt", voicePrompt: "Switch to Hearth.", lang: "en", last: true }));
  await until(() => received(ws!).some((c) => c.type === "text" && /Resume, or start fresh\?/.test(c.token)), "the resume offer");
  ws!.send(JSON.stringify({ type: "prompt", voicePrompt: "Resume.", lang: "en", last: true }));
  await until(() => registry.callSessions(CALL.callSid).length === 2, "the second session on record");
  const sessions = registry.callSessions(CALL.callSid);
  assert.equal(sessions[0]?.agent, "hearth");
  assert.ok(sessions[0]?.endedMs !== undefined, "the first session is closed");
  assert.equal(sessions[1]?.agent, "hearth");
  assert.equal(sessions[1]?.endedMs, undefined);
  await until(() => received(ws!).some((c) => c.type === "text" && /Resuming with Hearth/.test(c.token)), "reconnected");

  ws!.send(JSON.stringify({ type: "prompt", voicePrompt: "Goodbye.", lang: "en", last: true }));
  await until(() => received(ws!).some((c) => c.type === "end"), "the end command");
  assert.deepEqual(received(ws!).at(-1), { type: "end", handoffData: "goodbye" });
  assert.ok(s.alerts.some((a) => a.kind === "session_ended"));

  // Twilio's follow-up: the session ended, here is why.
  const unsigned = await post(s.port, "/action", { CallSid: CALL.callSid, SessionStatus: "ended", HandoffData: "goodbye" }, false);
  assert.equal(unsigned.status, 403);
  const res = await post(s.port, "/action", { CallSid: CALL.callSid, SessionStatus: "ended", HandoffData: "goodbye", SessionDuration: "42" });
  assert.equal(res.status, 200);
  assert.match(res.body, /<Say>Goodbye\.<\/Say><Hangup\/>/);
  assert.equal(registry.call(CALL.callSid)?.endReason, "goodbye");

  // Shape only, never content: no digit and no words in the log.
  const logged = JSON.stringify(s.logger.lines);
  assert.doesNotMatch(logged, /4729|oil|Goodbye\./);
  assert.ok(s.logger.lines.some((l) => l.msg === "frame" && l.fields?.kind === "key"));
  assert.ok(s.logger.lines.some((l) => l.msg === "command" && l.fields?.type === "text"));
  ws!.close();
});

test("the voice webhook answers with the relay TwiML and no greeting", async (t) => {
  const registry = new CallRegistry(":memory:");
  const s = await startServer(registry);
  t.after(() => s.phone.close());
  const res = await post(s.port, "/voice", { CallSid: "CA2", From: "+15550100001", To: "+15550100002", Direction: "inbound", CallStatus: "ringing" });
  assert.equal(res.status, 200);
  assert.match(res.body, /<Connect action="https:\/\/phone\.example\.net\/action"><ConversationRelay url="wss:\/\/phone\.example\.net\/relay\/fixture" /);
  assert.match(res.body, /speechModel="flux"/);
  assert.match(res.body, /dtmfDetection="true"/);
  assert.doesNotMatch(res.body, /welcomeGreeting/);
  assert.equal(registry.call("CA2")?.from, "+15550100001");
  assert.equal((await post(s.port, "/nothing", {})).status, 404);
});

test("after a restart, a call that ended while the bridge was down still gets its wrap-up record", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "phone-server-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "phone.db");

  const first = await startServer(new CallRegistry(dbPath));
  const { ws } = await connect(first.port, { "x-twilio-signature": twilioSignature(TOKEN, `wss://phone.example.net/relay/${SECRET}`) });
  ws!.send(JSON.stringify(CALL));
  await until(() => first.logger.lines.some((l) => l.msg === "frame" && l.fields?.kind === "setup"), "setup seen");
  await first.phone.close(); // the bridge goes down mid-call

  const second = await startServer(new CallRegistry(dbPath));
  t.after(() => second.phone.close());
  assert.equal(second.engineCount(), 0);
  const res = await post(second.port, "/action", { CallSid: CALL.callSid, SessionStatus: "failed", ErrorCode: "64105", ErrorMessage: "Websocket ended" });
  assert.equal(res.status, 200);
  assert.match(res.body, /<Hangup\/>/);
  const call = new CallRegistry(dbPath).call(CALL.callSid);
  assert.equal(call?.endReason, "failed:64105");
  assert.ok(call?.endedMs !== undefined && call.endedMs >= call.startedMs);
});

test("the bridge refuses to start without a PIN or an allow-list, and says which", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "phone-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = {
    public_base_url: PUBLIC,
    twilio: { account_sid: "AC" + "0".repeat(32), auth_token: TOKEN, number: "+15550100002" },
    operator_numbers: ["+15550100001"],
    pin: PIN,
  };
  const noPin = join(dir, "no-pin.json");
  writeFileSync(noPin, JSON.stringify({ ...base, pin: undefined }), { mode: 0o600 });
  await assert.rejects(run(noPin), /pin: /);
  const noList = join(dir, "no-list.json");
  writeFileSync(noList, JSON.stringify({ ...base, operator_numbers: [] }), { mode: 0o600 });
  await assert.rejects(run(noList), /operator_numbers: at least one operator number/);
});
