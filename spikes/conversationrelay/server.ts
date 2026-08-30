// Scratch ConversationRelay peer for the M0 spike (#19). Not shipped; nothing here
// survives into apps/phone. It answers the number with <Connect><ConversationRelay>,
// records every frame on the wire per call, and lets a caller (by voice or keypad) or
// the operator (over a localhost control port) trigger the behaviours the spike is
// meant to observe: streamed tokens, sendDigits during speech, end, malformed frames,
// an abrupt socket drop, and what the action webhook does next.
//
// Run from the repo root:  mise exec -- bun spikes/conversationrelay/server.ts
// See README.md beside this file for the commands and the observation list.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
};

const PUBLIC_PORT = Number(env("SPIKE_PORT", "8799"));
const CONTROL_PORT = Number(env("SPIKE_CONTROL_PORT", "8798"));
const BASE_URL = env("THICKET_PUBLIC_BASE_URL").replace(/\/$/, "");
const AUTH_TOKEN = env("TWILIO_AUTH_TOKEN");
const STATE_DIR = env("SPIKE_STATE", join(homedir(), "thicket-test", "spike-cr"));
const RELAY_SECRET = env("SPIKE_PATH_SECRET", randomBytes(12).toString("hex"));
const RECORDINGS = join(STATE_DIR, "recordings");
mkdirSync(RECORDINGS, { recursive: true });

const PUBLIC_HOST = new URL(BASE_URL).host;

// ---------------------------------------------------------------- recording

type Entry = Record<string, unknown>;
const started = Date.now();

function record(callSid: string | undefined, entry: Entry): void {
  const line = JSON.stringify({ t: new Date().toISOString(), ms: Date.now() - started, ...entry });
  console.log(line);
  if (callSid) appendFileSync(join(RECORDINGS, `${callSid}.jsonl`), line + "\n");
  else appendFileSync(join(RECORDINGS, "_unattributed.jsonl"), line + "\n");
}

// ---------------------------------------------------------------- signature

// https://www.twilio.com/docs/usage/webhooks/webhooks-security — HMAC-SHA1 over the
// full URL plus the sorted POST parameters, base64, compared to X-Twilio-Signature.
function signature(url: string, params: URLSearchParams | undefined): string {
  let data = url;
  if (params) {
    for (const key of [...params.keys()].sort()) data += key + params.get(key);
  }
  return createHmac("sha1", AUTH_TOKEN).update(data).digest("base64");
}

function signatureMatches(expected: string, header: string | null): boolean {
  if (!header) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The URL Twilio signed is the one it requested: our public base plus the path and
// query it saw, whatever Funnel rewrote the Host header to on the way in.
function requestedUrl(req: Request, scheme: string): string {
  const u = new URL(req.url);
  return `${scheme}://${PUBLIC_HOST}${u.pathname}${u.search}`;
}

// ---------------------------------------------------------------- call state

interface Call {
  callSid: string;
  ws: ServerWebSocket<Conn>;
  session: number; // increments on every fresh <Connect> for the same CallSid
  setupAt: number;
  interrupted: boolean;
  pending: number; // tokens queued but not yet confirmed played
}

interface Conn {
  id: string;
  callSid?: string;
  buffered: Entry[];
  signature: Record<string, boolean>;
}

const calls = new Map<string, Call>();
const sessionsByCall = new Map<string, number>();
let current: Call | undefined;

// What the action webhook returns next. Set by control `action`.
let nextAction: "hangup" | "say-hangup" | "reconnect" | "dial" = "hangup";
// Attribute overrides for <ConversationRelay>, set by control `twiml`.
let attrOverrides: Record<string, string> = {};

// ---------------------------------------------------------------- TwiML

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function relayTwiml(): string {
  const attrs: Record<string, string> = {
    url: `wss://${PUBLIC_HOST}/relay/${RELAY_SECRET}`,
    welcomeGreeting: "This is the spike. Say something, or press a key.",
    transcriptionProvider: "Deepgram",
    speechModel: "flux",
    partialPrompts: "true",
    dtmfDetection: "true",
    interruptible: "any",
    reportInputDuringAgentSpeech: "any",
    events: "speaker-events tokens-played",
    ...attrOverrides,
  };
  const rendered = Object.entries(attrs)
    .map(([k, v]) => `${k}="${escapeXml(v)}"`)
    .join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Connect action="${BASE_URL}/action"><ConversationRelay ${rendered}/></Connect></Response>`;
}

function actionTwiml(): string {
  switch (nextAction) {
    case "hangup":
      return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup/></Response>`;
    case "say-hangup":
      return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say>The relay session ended and the call is still up. Hanging up now.</Say><Hangup/></Response>`;
    case "reconnect":
      return relayTwiml();
    case "dial":
      // No second number to dial; <Say> stands in as "the call continued into other TwiML".
      return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say>Dial would go here.</Say><Pause length="2"/><Hangup/></Response>`;
  }
}

function twiml(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/xml" } });
}

// ---------------------------------------------------------------- outbound frames

function send(call: Call, frame: Record<string, unknown>): void {
  record(call.callSid, { dir: "out", session: call.session, frame });
  call.ws.send(JSON.stringify(frame));
}

function sendRaw(call: Call, raw: string): void {
  record(call.callSid, { dir: "out", session: call.session, raw });
  call.ws.send(raw);
}

// Stream text as word tokens, all queued at once, `last` on the final one.
function speak(call: Call, text: string, opts: { preemptible?: boolean } = {}): void {
  call.interrupted = false;
  const words = text.split(/\s+/).filter(Boolean);
  words.forEach((w, i) => {
    send(call, {
      type: "text",
      token: (i === 0 ? "" : " ") + w,
      last: i === words.length - 1,
      ...(opts.preemptible ? { preemptible: true } : {}),
    });
  });
}

const LONG_TEXT = Array.from({ length: 12 }, (_, i) =>
  `Sentence ${i + 1} of twelve: the quick brown fox jumps over the lazy dog while the spike keeps talking so you can interrupt it.`,
).join(" ");

// Behaviours a caller can trigger by voice or keypad; the control port reaches the same set.
function dispatch(call: Call, command: string, source: string): string {
  record(call.callSid, { dir: "note", command, source });
  switch (command) {
    case "long":
      speak(call, LONG_TEXT);
      return "long";
    case "busy-digits":
      speak(call, LONG_TEXT);
      setTimeout(() => send(call, { type: "sendDigits", digits: "1234#" }), 3000);
      return "busy-digits";
    case "digits":
      send(call, { type: "sendDigits", digits: "1234#" });
      return "digits";
    case "end":
      send(call, { type: "end", handoffData: JSON.stringify({ reason: "spike", command: source }) });
      return "end";
    case "drop":
      record(call.callSid, { dir: "note", terminate: true });
      call.ws.terminate();
      return "drop";
    case "malformed":
      for (let i = 0; i < 10; i++) sendRaw(call, `this is not json #${i + 1}`);
      return "malformed";
    case "silence":
      speak(call, "Okay. I will stay quiet now.");
      return "silence";
    case "preempt":
      speak(call, LONG_TEXT);
      setTimeout(() => speak(call, "Preempting with a new message.", { preemptible: true }), 3000);
      return "preempt";
    case "preempt-marked":
      // The reverse reading of the flag: the long text is what may be cut off.
      speak(call, LONG_TEXT, { preemptible: true });
      setTimeout(() => speak(call, "Replacing the marked message."), 3000);
      return "preempt-marked";
    default:
      return "";
  }
}

const VOICE_COMMANDS: Array<[RegExp, string]> = [
  [/busy digits/, "busy-digits"],
  [/send digits/, "digits"],
  [/\blong\b/, "long"],
  [/end session/, "end"],
  [/\bdrop\b/, "drop"],
  [/malformed/, "malformed"],
  [/\bsilence\b/, "silence"],
  [/preempt/, "preempt"],
];

const KEY_COMMANDS: Record<string, string> = {
  "1": "long",
  "2": "busy-digits",
  "3": "drop",
  "4": "malformed",
  "5": "end",
  "6": "preempt",
  "7": "digits",
  "0": "preempt-marked",
};

// ---------------------------------------------------------------- inbound frames

function onFrame(ws: ServerWebSocket<Conn>, raw: string): void {
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(raw);
  } catch {
    record(ws.data.callSid, { dir: "in", unparsable: raw });
    return;
  }
  const type = String(frame.type);

  if (type === "setup") {
    const callSid = String(frame.callSid);
    const session = (sessionsByCall.get(callSid) ?? 0) + 1;
    sessionsByCall.set(callSid, session);
    ws.data.callSid = callSid;
    const call: Call = { callSid, ws, session, setupAt: Date.now(), interrupted: false, pending: 0 };
    calls.set(callSid, call);
    current = call;
    for (const e of ws.data.buffered) record(callSid, e);
    ws.data.buffered = [];
    record(callSid, { dir: "in", session, frame });
    return;
  }

  const call = ws.data.callSid ? calls.get(ws.data.callSid) : undefined;
  if (!call) {
    ws.data.buffered.push({ dir: "in", frame });
    return;
  }
  record(call.callSid, { dir: "in", session: call.session, frame });

  switch (type) {
    case "prompt": {
      if (frame.last !== true) return;
      const text = String(frame.voicePrompt ?? "").toLowerCase();
      const hit = VOICE_COMMANDS.find(([re]) => re.test(text));
      if (hit && dispatch(call, hit[1], `voice:${text}`)) return;
      speak(call, `I heard: ${String(frame.voicePrompt ?? "")}`);
      return;
    }
    case "dtmf": {
      const digit = String(frame.digit);
      const command = KEY_COMMANDS[digit];
      if (command && dispatch(call, command, `dtmf:${digit}`)) return;
      speak(call, `Key ${digit === "#" ? "pound" : digit === "*" ? "star" : digit}.`);
      return;
    }
    case "interrupt":
      call.interrupted = true;
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------- public server

async function handlePublic(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === `/relay/${RELAY_SECRET}`) {
    const header = req.headers.get("x-twilio-signature");
    // Which string Twilio signed on the handshake is what the spike finds out.
    const candidates: Record<string, string> = {
      wss: requestedUrl(req, "wss"),
      https: requestedUrl(req, "https"),
      ws: requestedUrl(req, "ws"),
      http: requestedUrl(req, "http"),
    };
    const matched: Record<string, boolean> = {};
    for (const [name, candidate] of Object.entries(candidates)) matched[name] = signatureMatches(signature(candidate, undefined), header);
    const id = randomBytes(4).toString("hex");
    const entry: Entry = {
      dir: "ws",
      event: "handshake",
      id,
      signaturePresent: header !== null,
      signatureMatched: matched,
      headers: Object.fromEntries([...req.headers.entries()].filter(([k]) => !k.startsWith("x-twilio-signature"))),
    };
    const ok = server.upgrade(req, { data: { id, buffered: [entry], signature: matched } satisfies Conn });
    if (ok) return new Response(null);
    record(undefined, { ...entry, upgradeFailed: true });
    return new Response("upgrade failed", { status: 400 });
  }

  if (req.method !== "POST") {
    record(undefined, { dir: "http", path, method: req.method, status: 404, ua: req.headers.get("user-agent") });
    return new Response("not found", { status: 404 });
  }

  const params = new URLSearchParams(await req.text());
  const form = Object.fromEntries(params.entries());
  const valid = signatureMatches(signature(requestedUrl(req, "https"), params), req.headers.get("x-twilio-signature"));
  const callSid = form.CallSid;
  record(callSid, { dir: "http", path, signatureValid: valid, form });
  if (!valid) return new Response("bad signature", { status: 403 });

  switch (path) {
    case "/voice": {
      const body = relayTwiml();
      record(callSid, { dir: "http", path, response: body, nextAction });
      return twiml(body);
    }
    case "/action": {
      const body = actionTwiml();
      record(callSid, { dir: "http", path, response: body, nextAction });
      return twiml(body);
    }
    case "/status":
      return new Response(null, { status: 204 });
    case "/gather":
      // The synthetic caller leg's <Gather> reports the DTMF it heard from our sendDigits.
      return twiml(`<?xml version="1.0" encoding="UTF-8"?>\n<Response><Pause length="3"/><Hangup/></Response>`);
    default:
      return new Response("not found", { status: 404 });
  }
}

const publicServer = Bun.serve<Conn>({
  hostname: "127.0.0.1",
  port: PUBLIC_PORT,
  fetch: handlePublic,
  websocket: {
    open(ws) {
      ws.data.buffered.push({ dir: "ws", event: "open", id: ws.data.id });
    },
    message(ws, message) {
      onFrame(ws, typeof message === "string" ? message : Buffer.from(message).toString("utf8"));
    },
    close(ws, code, reason) {
      const call = ws.data.callSid ? calls.get(ws.data.callSid) : undefined;
      record(ws.data.callSid, {
        dir: "ws",
        event: "close",
        id: ws.data.id,
        code,
        reason,
        session: call?.session,
        sinceSetupMs: call ? Date.now() - call.setupAt : undefined,
      });
      if (call && current === call) current = undefined;
    },
  },
});

// ---------------------------------------------------------------- control server

async function handleControl(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({
      current: current ? { callSid: current.callSid, session: current.session, sinceSetupMs: Date.now() - current.setupAt } : null,
      nextAction,
      attrOverrides,
      relayUrl: `wss://${PUBLIC_HOST}/relay/${RELAY_SECRET}`,
      recordings: RECORDINGS,
    });
  }
  const body = (await req.json()) as Record<string, unknown>;
  const cmd = String(body.cmd);
  if (cmd === "action") {
    nextAction = body.twiml as typeof nextAction;
    return Response.json({ nextAction });
  }
  if (cmd === "twiml") {
    attrOverrides = (body.attrs as Record<string, string>) ?? {};
    return Response.json({ attrOverrides, twiml: relayTwiml() });
  }
  if (!current) return Response.json({ error: "no current call" }, { status: 409 });
  switch (cmd) {
    case "text":
      speak(current, String(body.text), { preemptible: body.preemptible === true });
      return Response.json({ ok: true });
    case "digits":
      send(current, { type: "sendDigits", digits: String(body.digits ?? "1234#") });
      return Response.json({ ok: true });
    case "raw":
      send(current, body.frame as Record<string, unknown>);
      return Response.json({ ok: true });
    default:
      return Response.json({ ran: dispatch(current, cmd, "control") || "unknown" });
  }
}

const controlServer = Bun.serve({ hostname: "127.0.0.1", port: CONTROL_PORT, fetch: handleControl });

console.log(
  JSON.stringify({
    listening: { public: publicServer.port, control: controlServer.port },
    voiceUrl: `${BASE_URL}/voice`,
    relayUrl: `wss://${PUBLIC_HOST}/relay/${RELAY_SECRET}`,
    recordings: RECORDINGS,
  }),
);
