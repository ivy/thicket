import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import { decodeInbound, endSession, playDigits, RelayCodecError, say, signatureValid, encodeOutbound, type CallEvent } from "@thicket/phone";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * The caller leg of a self-call, as proven by the #50 spike: the bridge's
 * number dials itself, this side runs its own ConversationRelay session,
 * and whoever drives it stands where the operator stands — hears the
 * bridge's speech as text, speaks with TTS tokens, keys digits, hangs up.
 *
 * The perspective is mirrored: on this leg, "agent" speaking is our own
 * TTS and "caller" speaking is the bridge's audio. `interruptible="none"`
 * keeps our speech from being cut by the far end; our speech still barges
 * the bridge, which is how the barge-in checks work.
 */

export interface TranscriptEntry {
  /** Milliseconds since this leg started. */
  ms: number;
  who: "said" | "heard" | "keyed" | "event";
  text: string;
}

export interface LegLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface CallerLegOptions {
  /** The Funnel origin Twilio dials back through, https, no path. */
  publicBaseUrl: string;
  /** The Funnel mount path routed here; Funnel strips it before proxying. */
  pathPrefix: string;
  /** Validates X-Twilio-Signature; the account's primary token. */
  authToken: string;
  /** Keyed on demand; never logged, never recorded, never in a transcript. */
  pin: string;
  rest: import("./caller.js").TwilioRestPort;
  recordingsDir: string;
  logger: LegLogger;
  /** Test override; random per process otherwise. */
  relaySecret?: string;
  /** Test override for the pause between edge-refused attempts. */
  retryPauseMs?: number;
}

export interface PlaceOptions {
  /** "dial" keys the PIN as post-dial digits (`ww<pin>`, no `#` — #54); "none" leaves the gate shut. */
  pin?: "dial" | "none";
  /** Attempts before giving up: the Funnel edge refuses intermittently (11200/64102). */
  attempts?: number;
  /** Caller-id override — a second identity for the unlisted-caller scenario. */
  from?: string;
}

/**
 * The verbs a driver of the leg uses — the MCP server's tools and the
 * scenario runner's scripts are both written against this.
 */
export interface CallerLegPort {
  place(options: PlaceOptions): Promise<PlaceResult>;
  say(text: string, options?: { overSpeech?: boolean }): Promise<{ playbackObserved: boolean }>;
  press(digits: string): Promise<void>;
  enterPin(): Promise<void>;
  awaitReply(options?: { timeoutMs?: number }): Promise<AwaitedUtterance>;
  transcript(): TranscriptEntry[];
  status(): LegStatus;
  hangup(how?: "end" | "rest"): Promise<void>;
}

export interface PlaceResult {
  callSid: string;
  attempts: number;
}

export interface AwaitedUtterance {
  text: string;
  /** Milliseconds since the leg started. */
  atMs: number;
  /** From the end of what was last said to this being heard; absent before any say. */
  sinceSaidMs?: number;
}

export interface LegStatus {
  call: { callSid: string; sinceSetupMs: number } | null;
  /** The bridge's audio playing right now. */
  farSpeaking: boolean;
  /** Our own TTS playing right now. */
  selfSpeaking: boolean;
  /** Utterances heard but not yet returned by awaitReply. */
  heardPending: number;
}

const SETUP_TIMEOUT_MS = 40_000;
const RETRY_PAUSE_MS = 8_000;
const HANGUP_TIMEOUT_MS = 10_000;

export class CallerLeg {
  private readonly started = Date.now();
  private readonly secret: string;
  private readonly host: string;

  private ws?: WebSocket;
  private callSid?: string;
  private restSid?: string;
  private setupAt?: number;
  private placeFailure?: string;

  private readonly entries: TranscriptEntry[] = [];
  private readonly heardList: Array<{ ms: number; wall: number; text: string }> = [];
  private heardCursor = 0;
  private lastSaidEndWall?: number;
  private farSpeakingNow = false;
  private selfSpeakingNow = false;
  private sayCycle?: { sawOn: boolean; done: boolean };

  private waiters: Array<() => void> = [];

  constructor(private readonly options: CallerLegOptions) {
    this.secret = options.relaySecret ?? randomBytes(12).toString("hex");
    this.host = new URL(options.publicBaseUrl).host;
    mkdirSync(options.recordingsDir, { recursive: true });
  }

  // ---------------------------------------------------------------- recording

  /** Spike-format JSONL, one file per call, PIN scrubbed no matter how it got in. */
  private record(entry: Record<string, unknown>): void {
    const line = JSON.stringify({ t: new Date().toISOString(), ms: Date.now() - this.started, ...entry }).replaceAll(
      this.options.pin,
      "«8 digits»",
    );
    const file = `${this.callSid ?? this.restSid ?? "_pending"}.jsonl`;
    try {
      appendFileSync(join(this.options.recordingsDir, file), line + "\n");
    } catch (err) {
      this.options.logger.warn("recording write failed", { err: String(err) });
    }
  }

  private note(who: TranscriptEntry["who"], text: string): void {
    this.entries.push({ ms: Date.now() - this.started, who, text });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  private async until(pred: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (pred()) {
        return true;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        return false;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 250));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  // ---------------------------------------------------------------- TwiML

  private twiml(): string {
    const escape = (value: string): string =>
      value.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
    // Not the bridge's RELAY_ATTRIBUTES: this leg is never interruptible
    // (the far end talking over us must not cut our own speech short),
    // and it needs no partial prompts — only finalized utterances.
    const attrs: Record<string, string> = {
      url: `wss://${this.host}${this.options.pathPrefix}/relay/${this.secret}`,
      transcriptionProvider: "Deepgram",
      speechModel: "flux",
      dtmfDetection: "true",
      interruptible: "none",
      reportInputDuringAgentSpeech: "any",
      events: "speaker-events tokens-played",
    };
    const rendered = Object.entries(attrs)
      .map(([key, value]) => `${key}="${escape(value)}"`)
      .join(" ");
    return (
      `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      `<Connect action="${this.options.publicBaseUrl}${this.options.pathPrefix}/action">` +
      `<ConversationRelay ${rendered}/></Connect></Response>`
    );
  }

  // ---------------------------------------------------------------- the tools' verbs

  async place(options: PlaceOptions = {}): Promise<PlaceResult> {
    if (this.ws !== undefined) {
      throw new Error("a call is already up — phone_hangup first");
    }
    const pin = options.pin ?? "dial";
    const attempts = options.attempts ?? 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.placeFailure = undefined;
      this.restSid = await this.options.rest.createCall({
        twiml: this.twiml(),
        statusCallback: `${this.options.publicBaseUrl}${this.options.pathPrefix}/status`,
        // `ww` waits a second so the far end's relay is up; no trailing `#`,
        // which barges in on the hello it unlocked (#54).
        ...(pin === "dial" ? { sendDigits: `ww${this.options.pin}` } : {}),
        ...(options.from === undefined ? {} : { from: options.from }),
      });
      this.record({ dir: "rest", createCall: true, pin, digitCount: pin === "dial" ? this.options.pin.length : 0, sid: this.restSid });
      if (pin === "dial") {
        this.note("keyed", `post-dial: ${"#".repeat(this.options.pin.length)}`);
      }
      await this.until(() => this.callSid !== undefined || this.placeFailure !== undefined, SETUP_TIMEOUT_MS);
      if (this.callSid !== undefined) {
        return { callSid: this.callSid, attempts: attempt };
      }
      const why = this.placeFailure ?? "no setup frame";
      this.options.logger.warn("call attempt failed", { attempt, why });
      this.note("event", `attempt ${attempt} failed: ${why}`);
      await this.options.rest.completeCall(this.restSid).catch(() => undefined);
      this.restSid = undefined;
      if (attempt < attempts) {
        // The edge's bad stretches last tens of seconds; growing pauses ride them out.
        await new Promise((resolve) => setTimeout(resolve, (this.options.retryPauseMs ?? RETRY_PAUSE_MS) * attempt));
      }
    }
    throw new Error(
      `no call after ${attempts} attempts — the Funnel edge refuses intermittently after a ` +
        `reconfig (Twilio errors 11200/64102); wait a minute and try again, and check the ` +
        `Twilio Alerts API for which hop failed`,
    );
  }

  async say(text: string, options: { overSpeech?: boolean } = {}): Promise<{ playbackObserved: boolean }> {
    const ws = this.requireCall();
    this.note("said", text);
    this.record({ dir: "note", said: text, overSpeech: options.overSpeech === true });
    const words = text.split(/\s+/).filter((word) => word !== "");
    const cycle = { sawOn: false, done: false };
    this.sayCycle = cycle;
    words.forEach((word, index) => {
      const frame = encodeOutbound(say((index === 0 ? "" : " ") + word, index === words.length - 1));
      ws.send(frame);
    });
    if (options.overSpeech === true) {
      this.lastSaidEndWall = Date.now();
      return { playbackObserved: false };
    }
    const observed = await this.until(() => cycle.done || this.ws === undefined, 3_000 + text.length * 90);
    this.lastSaidEndWall = Date.now();
    return { playbackObserved: observed && cycle.done };
  }

  /** Keys digits; the transcript and recording only ever carry the count. */
  async press(digits: string): Promise<void> {
    const ws = this.requireCall();
    this.note("keyed", "#".repeat(digits.length));
    this.record({ dir: "out", frame: { type: "sendDigits", digitCount: digits.length } });
    ws.send(encodeOutbound(playDigits(digits)));
  }

  async enterPin(): Promise<void> {
    await this.press(this.options.pin);
  }

  async awaitReply(options: { timeoutMs?: number } = {}): Promise<AwaitedUtterance> {
    const timeoutMs = options.timeoutMs ?? 45_000;
    const index = this.heardCursor;
    await this.until(() => this.heardList.length > index, timeoutMs);
    const entry = this.heardList[index];
    if (entry === undefined) {
      throw new Error(
        this.ws === undefined
          ? "the call ended before anything more was heard — phone_transcript has what there was"
          : `nothing heard in ${timeoutMs} ms — the agent may still be working (the bridge log's ` +
            `"turn latency" line says when it answered) or the far end may be waiting for you to speak`,
      );
    }
    this.heardCursor = index + 1;
    return {
      text: entry.text,
      atMs: entry.ms,
      ...(this.lastSaidEndWall === undefined ? {} : { sinceSaidMs: entry.wall - this.lastSaidEndWall }),
    };
  }

  transcript(): TranscriptEntry[] {
    return [...this.entries];
  }

  status(): LegStatus {
    return {
      call:
        this.callSid === undefined || this.setupAt === undefined
          ? null
          : { callSid: this.callSid, sinceSetupMs: Date.now() - this.setupAt },
      farSpeaking: this.farSpeakingNow,
      selfSpeaking: this.selfSpeakingNow,
      heardPending: this.heardList.length - this.heardCursor,
    };
  }

  async hangup(how: "end" | "rest" = "end"): Promise<void> {
    if (this.ws === undefined && this.restSid === undefined) {
      return;
    }
    if (how === "end" && this.ws !== undefined) {
      this.ws.send(encodeOutbound(endSession(JSON.stringify({ reason: "phone-test" }))));
    } else if (this.restSid !== undefined) {
      await this.options.rest.completeCall(this.restSid);
      this.record({ dir: "rest", updateStatus: "completed" });
    }
    await this.until(() => this.ws === undefined, HANGUP_TIMEOUT_MS);
  }

  private requireCall(): WebSocket {
    if (this.ws === undefined) {
      throw new Error("no call is up — phone_call first");
    }
    return this.ws;
  }

  // ---------------------------------------------------------------- frames

  private onEvent(event: CallEvent): void {
    this.record({ dir: "in", event: shapeOf(event) });
    switch (event.kind) {
      case "setup":
        this.callSid = event.callSid;
        this.setupAt = Date.now();
        this.note("event", `setup ${event.callSid}`);
        break;
      case "speech":
        if (event.final) {
          this.heardList.push({ ms: Date.now() - this.started, wall: Date.now(), text: event.text });
          this.note("heard", event.text);
        }
        break;
      case "speaking":
        // Mirrored perspective: "agent" is this leg's own TTS.
        if (event.who === "agent") {
          this.selfSpeakingNow = event.on;
          if (this.sayCycle !== undefined) {
            if (event.on) {
              this.sayCycle.sawOn = true;
            } else if (this.sayCycle.sawOn) {
              this.sayCycle.done = true;
              this.sayCycle = undefined;
            }
          }
        } else {
          this.farSpeakingNow = event.on;
        }
        break;
      case "interrupt":
        this.note("event", `own speech interrupted after: ${event.heard}`);
        break;
      case "relay-error":
        this.note("event", `relay error: ${event.description}`);
        this.options.logger.warn("relay error", { description: event.description });
        break;
      default:
        break;
    }
    this.wake();
  }

  // ---------------------------------------------------------------- the server

  /**
   * The public surface behind the Funnel path: the relay WebSocket and the
   * two webhooks. Funnel strips the mount prefix, so both the stripped and
   * the prefixed shapes are accepted; signatures are always over the URL
   * Twilio was given, prefix included.
   */
  createServer(): Server {
    const wss = new WebSocketServer({ noServer: true });
    const server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", this.options.publicBaseUrl);
        const tail = this.strip(url.pathname);
        if (req.method !== "POST" || (tail !== "/action" && tail !== "/status")) {
          this.options.logger.info("request refused", { method: req.method, path: url.pathname, status: 404 });
          res.writeHead(404).end("not found");
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const form = Object.fromEntries(params.entries());
        const signed = `${this.options.publicBaseUrl}${this.options.pathPrefix}${tail}`;
        const header = req.headers["x-twilio-signature"];
        if (!signatureValid(this.options.authToken, signed, form, typeof header === "string" ? header : undefined)) {
          this.options.logger.warn("webhook refused", { path: tail, signature: header === undefined ? "missing" : "bad" });
          res.writeHead(403).end("bad signature");
          return;
        }
        if (tail === "/action") {
          this.record({ dir: "http", path: tail, sessionStatus: form.SessionStatus, errorCode: form.ErrorCode });
          this.note("event", `action: ${String(form.SessionStatus ?? "")}${form.ErrorCode === undefined ? "" : ` ${form.ErrorCode}`}`);
          res.writeHead(200, { "content-type": "text/xml" }).end(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
          return;
        }
        this.record({ dir: "http", path: tail, callStatus: form.CallStatus });
        if (
          form.CallSid === this.restSid &&
          (form.CallStatus === "busy" || form.CallStatus === "failed" || form.CallStatus === "no-answer")
        ) {
          this.placeFailure = String(form.CallStatus);
          this.wake();
        }
        res.writeHead(204).end();
      })().catch((err: unknown) => {
        this.options.logger.warn("webhook failed", { err: String(err) });
        if (!res.headersSent) {
          res.writeHead(500).end("error");
        }
      });
    });

    const refuse = (socket: Duplex, status: number, reason: string, fields: Record<string, unknown>): void => {
      this.options.logger.warn("handshake refused", { status, ...fields });
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", this.options.publicBaseUrl);
      if (this.strip(url.pathname) !== `/relay/${this.secret}`) {
        refuse(socket, 404, "Not Found", { path: url.pathname });
        return;
      }
      const header = req.headers["x-twilio-signature"];
      const signed = `wss://${this.host}${this.options.pathPrefix}/relay/${this.secret}`;
      if (!signatureValid(this.options.authToken, signed, undefined, typeof header === "string" ? header : undefined)) {
        refuse(socket, 403, "Forbidden", { signature: header === undefined ? "missing" : "bad" });
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws));
    });

    return server;
  }

  private strip(pathname: string): string {
    return pathname.startsWith(this.options.pathPrefix) ? pathname.slice(this.options.pathPrefix.length) : pathname;
  }

  private attach(ws: WebSocket): void {
    if (this.ws !== undefined) {
      this.options.logger.warn("second relay connection refused", {});
      ws.close(1013, "one call at a time");
      return;
    }
    this.ws = ws;
    this.options.logger.info("relay connected", {});
    ws.on("message", (data) => {
      const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      try {
        this.onEvent(decodeInbound(raw));
      } catch (err) {
        this.options.logger.warn("frame ignored", { err: err instanceof RelayCodecError ? err.message : String(err) });
      }
    });
    ws.on("close", (code) => {
      this.record({ dir: "ws", event: "close", code });
      this.note("event", `call ended (close ${code})`);
      this.ws = undefined;
      this.callSid = undefined;
      this.setupAt = undefined;
      this.restSid = undefined;
      this.farSpeakingNow = false;
      this.selfSpeakingNow = false;
      this.wake();
    });
    ws.on("error", (err) => {
      this.options.logger.warn("relay socket error", { err: String(err) });
    });
  }
}

/** Shape only: speech text is kept (it is the point), digits never appear as events on this leg. */
function shapeOf(event: CallEvent): Record<string, unknown> {
  switch (event.kind) {
    case "setup":
      return { kind: event.kind, callSid: event.callSid, direction: event.direction };
    case "speech":
      return { kind: event.kind, final: event.final, text: event.text };
    case "speaking":
      return { kind: event.kind, who: event.who, on: event.on };
    case "interrupt":
      return { kind: event.kind, heardChars: event.heard.length, afterMs: event.afterMs };
    case "played":
      return { kind: event.kind, chars: event.text.length };
    default:
      return { kind: event.kind };
  }
}
