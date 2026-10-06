// Scratch Discord peer for the bridge spikes. Not shipped; nothing here survives
// into apps/discord. It holds one Gateway connection through the egress socket,
// records every frame on the wire, and takes scenario commands over a localhost
// control port so the questions the design doc needs answered — resume hosts,
// edit budgets, the Components V2 limits, the question-as-modal flow — are
// observed rather than assumed.
//
// Run from the repo root with the egress stand-in up (see README.md beside this):
//   mise exec -- bun spikes/discord/spike.ts
//
// Every outbound leg goes through SOCKET. There is no direct-dial path, so a leg
// that works here works from a bridge with no network of its own.

import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

// Not "ws": Bun's built-in answers the bare specifier and ignores `agent`, so the
// socket would dial straight out. The Slack bridge's alias is the installed
// package under a name Bun has no built-in for; see spikes/bridge-egress/.
import WebSocket from "../../apps/slack/node_modules/slack-ws/index.js";
import { assertEgressSocket, egressAgent, egressFetch } from "../../packages/egress/src/index.ts";

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
};

const TOKEN = env("DISCORD_BOT_TOKEN");
const APP_ID = env("DISCORD_APP_ID");
const GUILD_ID = env("SPIKE_GUILD_ID");
const CHANNEL_ID = env("SPIKE_CHANNEL_ID");
const SOCKET = env("SOCKET", join(homedir(), "thicket-test", "run", "thicket", "netd-egress.sock"));
const CONTROL_PORT = Number(env("SPIKE_CONTROL_PORT", "8795"));
const STATE_DIR = env("SPIKE_STATE", join(homedir(), "thicket-test", "spike-discord"));
const RECORDINGS = join(STATE_DIR, "recordings");
mkdirSync(RECORDINGS, { recursive: true });

// Gateway intents. MESSAGE_CONTENT is the privileged one; run once with it and
// once without (SPIKE_INTENTS=nocontent) to record what each message carries.
const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  GUILD_MESSAGE_TYPING: 1 << 11,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  MESSAGE_CONTENT: 1 << 15,
};
const BASE_INTENTS =
  INTENTS.GUILDS |
  INTENTS.GUILD_MESSAGES |
  INTENTS.GUILD_MESSAGE_REACTIONS |
  INTENTS.GUILD_MESSAGE_TYPING |
  INTENTS.DIRECT_MESSAGES |
  INTENTS.DIRECT_MESSAGE_REACTIONS;
const INTENT_BITS = process.env.SPIKE_INTENTS === "nocontent" ? BASE_INTENTS : BASE_INTENTS | INTENTS.MESSAGE_CONTENT;

const IS_COMPONENTS_V2 = 1 << 15;
const EPHEMERAL = 1 << 6;
const SUPPRESS_NOTIFICATIONS = 1 << 12;

assertEgressSocket(SOCKET);
const fetchOut = egressFetch(SOCKET);
const agent = egressAgent(SOCKET);

// ---------------------------------------------------------------- recording

type Entry = Record<string, unknown>;
const started = Date.now();
let scenario = "default";

function redact(value: unknown): unknown {
  // The bot token appears in Identify and Resume; nothing else here is secret,
  // and the test server's content is the point of the recording.
  return JSON.parse(JSON.stringify(value).replaceAll(TOKEN, "<bot-token>"));
}

function record(entry: Entry): void {
  const line = JSON.stringify({ t: new Date().toISOString(), ms: Date.now() - started, ...redact(entry) });
  console.log(line);
  appendFileSync(join(RECORDINGS, `${scenario}.jsonl`), line + "\n");
}

// ---------------------------------------------------------------- REST

const API = "https://discord.com/api/v10";

interface ApiResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** One REST call, every rate-limit header recorded, a 429 waited out once. */
async function api(method: string, path: string, body?: unknown, extra?: { multipart?: Multipart; reason?: string }): Promise<ApiResult> {
  const headers: Record<string, string> = {
    authorization: `Bot ${TOKEN}`,
    "user-agent": "DiscordBot (https://github.com/ivy/thicket, spike)",
  };
  let payload: string | Uint8Array | undefined;
  if (extra?.multipart) {
    headers["content-type"] = `multipart/form-data; boundary=${extra.multipart.boundary}`;
    payload = extra.multipart.body;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (extra?.reason) headers["x-audit-log-reason"] = extra.reason;
  const t0 = Date.now();
  const res = await fetchOut(`${API}${path}`, { method, headers, body: payload });
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (k.startsWith("x-ratelimit") || k === "retry-after") out[k] = v;
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    // not JSON; keep the text
  }
  record({
    kind: "rest",
    method,
    path,
    status: res.status,
    ms: Date.now() - t0,
    ratelimit: out,
    ...(res.status >= 400 ? { error: parsed } : {}),
  });
  if (res.status === 429) {
    const retryAfter = Number((parsed as { retry_after?: number })?.retry_after ?? out["retry-after"] ?? 1);
    record({ kind: "rest-429", path, retryAfter, scope: out["x-ratelimit-scope"] });
    await sleep(retryAfter * 1000 + 50);
    return api(method, path, body, extra);
  }
  return { status: res.status, headers: out, body: parsed };
}

interface Multipart {
  boundary: string;
  body: Uint8Array;
}

/** A hand-built multipart body: egressFetch takes only strings and bytes. */
function multipart(payloadJson: unknown, files: { name: string; bytes: Uint8Array; type: string }[]): Multipart {
  const boundary = `----thicket${Date.now().toString(16)}`;
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  parts.push(enc.encode(`--${boundary}\r\ncontent-disposition: form-data; name="payload_json"\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(payloadJson)}\r\n`));
  files.forEach((f, i) => {
    parts.push(enc.encode(`--${boundary}\r\ncontent-disposition: form-data; name="files[${i}]"; filename="${f.name}"\r\ncontent-type: ${f.type}\r\n\r\n`));
    parts.push(f.bytes);
    parts.push(enc.encode("\r\n"));
  });
  parts.push(enc.encode(`--${boundary}--\r\n`));
  const size = parts.reduce((n, p) => n + p.length, 0);
  const body = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    body.set(p, offset);
    offset += p.length;
  }
  return { boundary, body };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- gateway

interface GatewayFrame {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

interface Session {
  id: string;
  resumeUrl: string;
  seq: number | null;
}

let socket: WebSocket | null = null;
let session: Session | null = null;
let connectUrl = "";

/**
 * Heartbeat state belongs to one socket. Shared across connections, a timer
 * left over from a dead socket beats on it, never sees an ack, and the shared
 * flag then kills the live socket as a zombie.
 */
interface Beat {
  first: NodeJS.Timeout | null;
  interval: NodeJS.Timeout | null;
  awaitingAck: boolean;
}
const beats = new WeakMap<WebSocket, Beat>();

function stopBeat(ws: WebSocket): void {
  const beat = beats.get(ws);
  if (!beat) return;
  if (beat.first) clearTimeout(beat.first);
  if (beat.interval) clearInterval(beat.interval);
  beats.delete(ws);
}

async function gatewayUrl(): Promise<string> {
  const res = await api("GET", "/gateway/bot");
  if (res.status !== 200) throw new Error(`GET /gateway/bot answered ${res.status}: ${JSON.stringify(res.body)}`);
  const d = res.body as { url: string; session_start_limit: unknown; shards: number };
  record({ kind: "gateway-bot", url: d.url, shards: d.shards, sessionStartLimit: d.session_start_limit });
  return d.url;
}

async function connect(resume: boolean): Promise<void> {
  const base = resume && session ? session.resumeUrl : await gatewayUrl();
  connectUrl = `${base}${base.includes("?") ? "&" : "?"}v=10&encoding=json`;
  // The hostname is the finding: egress admits destinations by name, so a
  // resume host that differs from the connect host is a second allow entry.
  record({ kind: "ws-connect", resume, host: new URL(connectUrl).host });
  const ws = new WebSocket(connectUrl, { agent });
  socket = ws;
  ws.on("open", () => record({ kind: "ws-open", host: new URL(connectUrl).host }));
  ws.on("message", (data: Buffer) => onFrame(ws, data, resume));
  ws.on("close", (code: number, reason: Buffer) => {
    record({ kind: "ws-close", code, reason: reason.toString() });
    stopBeat(ws);
    if (socket === ws) socket = null;
    // 4004 auth, 4010-4014 bad shard/intents: do not retry. Everything else
    // resumes; op 9 with d:false below downgrades that to a fresh identify.
    if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) return;
    setTimeout(() => void connect(session !== null), 1000 + Math.random() * 4000);
  });
  ws.on("error", (err: Error) => record({ kind: "ws-error", message: err.message }));
}

function send(ws: WebSocket, frame: GatewayFrame): void {
  record({ kind: "ws-send", op: frame.op, d: frame.op === 1 ? frame.d : frame.op === 2 ? "identify" : frame.op === 6 ? "resume" : frame.d });
  ws.send(JSON.stringify(frame));
}

function onFrame(ws: WebSocket, data: Buffer, resume: boolean): void {
  const frame = JSON.parse(data.toString()) as GatewayFrame;
  if (typeof frame.s === "number" && session) session.seq = frame.s;
  switch (frame.op) {
    case 10: {
      const interval = (frame.d as { heartbeat_interval: number }).heartbeat_interval;
      record({ kind: "hello", heartbeatIntervalMs: interval });
      stopBeat(ws);
      const beat: Beat = { first: null, interval: null, awaitingAck: false };
      beats.set(ws, beat);
      beat.first = setTimeout(() => {
        send(ws, { op: 1, d: session?.seq ?? null });
        beat.awaitingAck = true;
        beat.interval = setInterval(() => {
          if (beat.awaitingAck) {
            record({ kind: "zombie", note: "no heartbeat ack since last beat; closing to resume" });
            ws.terminate();
            return;
          }
          send(ws, { op: 1, d: session?.seq ?? null });
          beat.awaitingAck = true;
        }, interval);
      }, interval * Math.random());
      if (resume && session) {
        send(ws, { op: 6, d: { token: TOKEN, session_id: session.id, seq: session.seq } });
      } else {
        send(ws, {
          op: 2,
          d: {
            token: TOKEN,
            intents: INTENT_BITS,
            properties: { os: "darwin", browser: "thicket-spike", device: "thicket-spike" },
          },
        });
      }
      return;
    }
    case 11: {
      const beat = beats.get(ws);
      if (beat) beat.awaitingAck = false;
      record({ kind: "heartbeat-ack" });
      return;
    }
    case 1:
      send(ws, { op: 1, d: session?.seq ?? null });
      return;
    case 7:
      record({ kind: "reconnect-requested" });
      ws.close(4000, "reconnect requested");
      return;
    case 9:
      record({ kind: "invalid-session", resumable: frame.d });
      if (frame.d !== true) session = null;
      ws.close(4000, "invalid session");
      return;
    case 0:
      onDispatch(ws, frame.t ?? "", frame.d);
      return;
    default:
      record({ kind: "op", op: frame.op, d: frame.d });
  }
}

function onDispatch(ws: WebSocket, type: string, d: unknown): void {
  if (type === "READY") {
    const ready = d as { session_id: string; resume_gateway_url: string; user: { id: string; username: string }; guilds: unknown[] };
    session = { id: ready.session_id, resumeUrl: ready.resume_gateway_url, seq: session?.seq ?? null };
    record({
      kind: "ready",
      user: ready.user,
      resumeHost: new URL(ready.resume_gateway_url).host,
      connectHost: new URL(connectUrl).host,
      guilds: ready.guilds.length,
    });
    return;
  }
  // GUILD_CREATE arrives once per guild on identify and is large; its shape is
  // not what this spike is for.
  if (type === "GUILD_CREATE") {
    record({ kind: "dispatch", t: type, id: (d as { id: string }).id });
    return;
  }
  record({ kind: "dispatch", t: type, d });
  if (type === "MESSAGE_CREATE") void onMessage(d as Message);
  if (type === "INTERACTION_CREATE") void onInteraction(d as Interaction);
}

// ---------------------------------------------------------------- behaviour

interface Message {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: { id: string; bot?: boolean; username: string };
  webhook_id?: string;
  content: string;
  attachments: { id: string; filename: string; url: string; size: number; content_type?: string }[];
  mentions: { id: string }[];
  message_reference?: unknown;
  referenced_message?: { author?: { id: string } } | null;
  thread?: unknown;
  flags?: number;
}

let me: string | null = null;

/** The echo: every human message gets a reply so content visibility is on the record. */
async function onMessage(m: Message): Promise<void> {
  if (m.author.bot || m.webhook_id) return;
  if (me === null) {
    const res = await api("GET", "/users/@me");
    me = (res.body as { id: string }).id;
  }
  const mentioned = m.mentions.some((u) => u.id === me);
  record({
    kind: "visibility",
    channel: m.channel_id,
    guild: m.guild_id ?? null,
    mentioned,
    reply: m.message_reference !== undefined,
    contentLength: m.content.length,
    attachments: m.attachments.map((a) => ({ name: a.filename, size: a.size, type: a.content_type, urlHost: new URL(a.url).host, urlParams: [...new URL(a.url).searchParams.keys()] })),
  });
  if (m.content.startsWith("!")) {
    await runCommand(m.content.slice(1), m);
    return;
  }
  await api("POST", `/channels/${m.channel_id}/messages`, {
    content: `heard ${m.content.length} chars${mentioned ? " (mentioned)" : ""}${m.attachments.length ? `, ${m.attachments.length} file(s)` : ""}`,
    message_reference: { message_id: m.id },
    allowed_mentions: { replied_user: false },
  });
}

interface Interaction {
  id: string;
  token: string;
  type: number;
  channel_id?: string;
  message?: { id: string };
  data?: { custom_id?: string; name?: string; component_type?: number; values?: string[]; components?: unknown[] };
  member?: { user: { id: string } };
  user?: { id: string };
}

async function respond(i: Interaction, type: number, data?: unknown): Promise<ApiResult> {
  return api("POST", `/interactions/${i.id}/${i.token}/callback?with_response=true`, { type, data });
}

/** The question flow: a message with an Answer button opens the modal. */
async function onInteraction(i: Interaction): Promise<void> {
  const customId = i.data?.custom_id ?? "";
  if (i.type === 2 && i.data?.name === "spike") {
    // Slash command: defer (type 5) so Discord shows its own thinking state,
    // then edit @original, to see what the loading message looks like.
    await respond(i, 5);
    await sleep(2500);
    await api("PATCH", `/webhooks/${APP_ID}/${i.token}/messages/@original`, {
      flags: IS_COMPONENTS_V2,
      components: [textDisplay("Deferred, then edited through the interaction webhook route.")],
    });
    return;
  }
  if (i.type === 3 && customId === "answer") {
    await respond(i, 9, questionModal());
    return;
  }
  if (i.type === 3 && customId === "stop") {
    await respond(i, 7, { flags: IS_COMPONENTS_V2, components: [container([textDisplay("**Stopped.**")], 0xed4245)] });
    return;
  }
  if (i.type === 3 && customId === "approve") {
    await respond(i, 4, { content: "Approved (ephemeral confirmation).", flags: EPHEMERAL });
    return;
  }
  if (i.type === 3 && customId === "pick") {
    // Keep the card and its buttons; only note the pick, so the quick answer
    // and the full answer can both be tried on one card.
    await respond(i, 7, { flags: IS_COMPONENTS_V2, components: questionCard(`Picked: ${i.data?.values?.join(", ")}`) });
    return;
  }
  if (i.type === 5) {
    // Modal submit: the whole payload is already in the recording; ack it.
    await respond(i, 4, { content: `Answered: \`${JSON.stringify(i.data?.components)}\``, flags: EPHEMERAL });
    return;
  }
  record({ kind: "interaction-unhandled", type: i.type, customId });
}

// ---------------------------------------------------------------- components

const textDisplay = (content: string) => ({ type: 10, content });
const separator = (large = false) => ({ type: 14, divider: true, spacing: large ? 2 : 1 });
const button = (custom_id: string, label: string, style = 2) => ({ type: 2, custom_id, label, style });
const container = (components: unknown[], accent_color?: number) => ({ type: 17, accent_color, components });
const section = (texts: string[], accessory: unknown) => ({ type: 9, components: texts.map(textDisplay), accessory });

/** What a live turn would look like: status, steps, streamed text, a stop. */
function turnCard(status: string, steps: { title: string; state: "running" | "done" | "failed" }[], text: string): unknown[] {
  const glyph = { running: "⏳", done: "✅", failed: "❌" };
  return [
    container(
      [
        section([`**${status}**`], button("stop", "Stop", 4)),
        separator(),
        ...steps.map((s) => textDisplay(`${glyph[s.state]} ${s.title}`)),
        separator(true),
        textDisplay(text),
      ],
      0x5865f2,
    ),
  ];
}

function questionCard(note?: string): unknown[] {
  return [
    container(
      [
        textDisplay(`**The agent has a question**\nWhich platforms should the release build for?${note ? `\n_${note}_` : ""}`),
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: "pick",
              placeholder: "Pick one quickly…",
              options: [
                { label: "linux-x64", value: "linux-x64" },
                { label: "macos-arm64", value: "macos-arm64" },
                { label: "both", value: "both" },
              ],
            },
          ],
        },
        { type: 1, components: [button("answer", "Answer in full…", 1), button("approve", "Approve", 3)] },
      ],
      0xfee75c,
    ),
  ];
}

function questionModal(): unknown {
  return {
    custom_id: "q1",
    title: "Release platforms",
    components: [
      {
        type: 18,
        label: "Which platforms?",
        description: "One answer",
        component: {
          type: 21,
          custom_id: "platforms",
          options: [
            { label: "linux-x64", value: "linux-x64", description: "The server" },
            { label: "macos-arm64", value: "macos-arm64", description: "The laptop" },
            { label: "Both", value: "both" },
          ],
        },
      },
      {
        type: 18,
        label: "Also run",
        component: {
          type: 22,
          custom_id: "also",
          // Discord refuses a required component with min_values 0
          // (COMPONENT_REQUIRED_ZERO_MIN_VALUES); optional has to be said.
          required: false,
          min_values: 0,
          max_values: 2,
          options: [
            { label: "Tests", value: "test" },
            { label: "Lint", value: "lint" },
          ],
        },
      },
      {
        type: 18,
        label: "Anything else",
        component: { type: 4, custom_id: "other", style: 2, required: false, placeholder: "Free text, the 'Other' option" },
      },
      {
        type: 18,
        label: "Attach a log",
        component: { type: 19, custom_id: "log", min_values: 0, max_values: 1, required: false },
      },
    ],
  };
}

// ---------------------------------------------------------------- scenarios

const STEPS = [
  { title: "Read agents.yaml", state: "done" as const },
  { title: "Render manifests", state: "running" as const },
];

async function runCommand(line: string, origin?: Message): Promise<unknown> {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ");
  const channel = origin?.channel_id ?? CHANNEL_ID;
  switch (cmd) {
    case "scenario":
      scenario = arg || "default";
      record({ kind: "scenario", name: scenario });
      return { scenario };

    case "card":
      return api("POST", `/channels/${channel}/messages`, {
        flags: IS_COMPONENTS_V2,
        components: turnCard("Working — rendering manifests", STEPS, "Here is the first paragraph of a reply, streamed."),
      });

    case "question":
      return api("POST", `/channels/${channel}/messages`, { flags: IS_COMPONENTS_V2, components: questionCard() });

    case "stream": {
      // Edit the same V2 message once a second; the headers say what the
      // budget really is, and the recording says how a 429 is reported.
      const seconds = Number(arg || 60);
      const post = await api("POST", `/channels/${channel}/messages`, {
        flags: IS_COMPONENTS_V2 | SUPPRESS_NOTIFICATIONS,
        components: turnCard("Working", STEPS, "…"),
      });
      const id = (post.body as { id: string }).id;
      let text = "";
      const words = "the quick brown fox jumps over the lazy dog and keeps going".split(" ");
      for (let n = 0; n < seconds; n++) {
        text += (n ? " " : "") + words[n % words.length];
        const t0 = Date.now();
        await api("PATCH", `/channels/${channel}/messages/${id}`, {
          flags: IS_COMPONENTS_V2,
          components: turnCard(`Working — edit ${n + 1}`, STEPS, text),
        });
        await sleep(Math.max(0, 1000 - (Date.now() - t0)));
      }
      await api("PATCH", `/channels/${channel}/messages/${id}`, {
        flags: IS_COMPONENTS_V2,
        components: turnCard("Done", STEPS.map((s) => ({ ...s, state: "done" as const })), text),
      });
      return { id, edits: seconds };
    }

    case "burst": {
      // Edits as fast as the API allows, to find the per-channel edit bucket.
      const post = await api("POST", `/channels/${channel}/messages`, { content: "burst 0" });
      const id = (post.body as { id: string }).id;
      for (let n = 1; n <= Number(arg || 12); n++) {
        await api("PATCH", `/channels/${channel}/messages/${id}`, { content: `burst ${n}` });
      }
      return { id };
    }

    case "limit": {
      // Grow one Text Display until the API refuses; the error body is the limit.
      let size = Number(arg || 2000);
      for (;;) {
        const res = await api("POST", `/channels/${channel}/messages`, {
          flags: IS_COMPONENTS_V2,
          components: [textDisplay("x".repeat(size))],
        });
        if (res.status >= 400) return { refusedAt: size, error: res.body };
        size += 1000;
        if (size > 12000) return { acceptedUpTo: size - 1000 };
      }
    }

    case "limit-split": {
      // Two Text Displays: does the limit apply per component or per message?
      const size = Number(arg || 3000);
      return api("POST", `/channels/${channel}/messages`, {
        flags: IS_COMPONENTS_V2,
        components: [textDisplay("a".repeat(size)), separator(), textDisplay("b".repeat(size))],
      });
    }

    case "upload": {
      const bytes = new TextEncoder().encode(`spike upload at ${new Date().toISOString()}\n`.repeat(50));
      const mp = multipart(
        {
          flags: IS_COMPONENTS_V2,
          components: [textDisplay("A file, through a hand-built multipart body."), { type: 13, file: { url: "attachment://spike.txt" } }],
          attachments: [{ id: 0, filename: "spike.txt", description: "spike output" }],
        },
        [{ name: "spike.txt", bytes, type: "text/plain" }],
      );
      return api("POST", `/channels/${channel}/messages`, undefined, { multipart: mp });
    }

    case "thread": {
      // A thread from a message: its id equals the message id.
      const post = await api("POST", `/channels/${channel}/messages`, { content: "a message that becomes a thread" });
      const id = (post.body as { id: string }).id;
      const thread = await api("POST", `/channels/${channel}/messages/${id}/threads`, { name: arg || "spike thread", auto_archive_duration: 60 });
      const tid = (thread.body as { id: string }).id;
      await api("POST", `/channels/${tid}/messages`, { content: "first message in the thread" });
      return { message: id, thread: tid, same: id === tid };
    }

    case "post":
      // post <channelOrThreadId> <text>: can this bot post into a thread it did not start?
      return api("POST", `/channels/${rest[0]}/messages`, { content: rest.slice(1).join(" ") || "posted" });

    case "archive": {
      // archive <threadId>: archive it, then post — does the post unarchive?
      await api("PATCH", `/channels/${arg}`, { archived: true });
      await sleep(1500);
      const post = await api("POST", `/channels/${arg}/messages`, { content: "posted into an archived thread" });
      const after = await api("GET", `/channels/${arg}`);
      return { post: post.status, threadMetadata: (after.body as { thread_metadata?: unknown }).thread_metadata };
    }

    case "typing":
      return api("POST", `/channels/${channel}/typing`);

    case "nick":
      return api("PATCH", `/guilds/${GUILD_ID}/members/@me`, { nick: arg || "spike agent", bio: "A thicket spike." });

    case "presence": {
      if (!socket) return { error: "no socket" };
      send(socket, { op: 3, d: { since: null, activities: [{ name: "status", type: 4, state: arg || "working on 2 tasks" }], status: "online", afk: false } });
      return { sent: true };
    }

    case "commands":
      return api("PUT", `/applications/${APP_ID}/guilds/${GUILD_ID}/commands`, [
        { name: "spike", description: "Deferred response, then an edit", type: 1 },
      ]);

    case "disconnect":
      // No close frame: the zombie path, which must end in a resume.
      socket?.terminate();
      return { terminated: true };

    case "reconnect":
      socket?.close(4000, "spike reconnect");
      return { closed: true };

    case "fresh":
      session = null;
      socket?.close(4000, "spike fresh identify");
      return { closed: true, session: null };

    case "status":
      return { scenario, session: session ? { ...session } : null, connected: socket?.readyState === 1, intents: INTENT_BITS };

    default:
      return { error: `unknown command ${cmd}` };
  }
}

// ---------------------------------------------------------------- control

createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(await runCommand("status"), null, 2));
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const { cmd } = JSON.parse(body || "{}") as { cmd?: string };
  try {
    const out = await runCommand(cmd ?? "status");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out, null, 2));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}).listen(CONTROL_PORT, "127.0.0.1", () => {
  record({ kind: "control", port: CONTROL_PORT, intents: INTENT_BITS });
});

void connect(false);
