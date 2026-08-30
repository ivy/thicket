import { readFileSync } from "node:fs";
import { request } from "node:http";

import WebSocket from "ws";
import { RemoteAgentClient } from "@thicket/a2a-client";
import {
  buildPhoneServer,
  CallEngine,
  CallRegistry,
  twilioSignature,
  type PhoneAlert,
  type PhoneServer,
  type RelayCommand,
} from "@thicket/phone";
import type { PhoneAgent } from "@thicket/roster";

import { netdFetch, type RunningAgent } from "./harness.js";

export const PUBLIC = "https://phone.example.net";
export const AUTH_TOKEN = "integration-auth-token";
export const RELAY_SECRET = "fixture";
/** The test PIN the spike's dial-string recordings key. */
export const PIN = "47290138";

const FIXTURES = new URL("../../fixtures/conversationrelay/", import.meta.url);

/** A frame as Twilio sent it during a recorded call, with when it arrived. */
export interface RecordedFrame {
  ms: number;
  frame: Record<string, unknown>;
}

/** Every inbound frame of one recording, in order: the spike's frames, not approximations. */
export function fixtureFrames(name: string): RecordedFrame[] {
  const frames: RecordedFrame[] = [];
  for (const line of readFileSync(new URL(`${name}.jsonl`, FIXTURES), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { dir: string; ms: number; frame?: Record<string, unknown> };
    if (entry.dir === "in" && entry.frame !== undefined) {
      frames.push({ ms: entry.ms, frame: entry.frame });
    }
  }
  return frames;
}

export function ofType(frames: RecordedFrame[], type: string): RecordedFrame[] {
  return frames.filter((f) => f.frame.type === type);
}

/** The recorded `setup` for a call, with a different CallSid when a scenario needs a second call. */
export function setupFrame(name = "dial-string-pin", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const setup = ofType(fixtureFrames(name), "setup")[0];
  if (setup === undefined) throw new Error(`${name} has no setup frame`);
  return { ...setup.frame, ...overrides };
}

export function promptFrame(text: string): Record<string, unknown> {
  return { type: "prompt", voicePrompt: text, lang: "en", last: true };
}

export interface RunningPhone {
  phone: PhoneServer;
  port: number;
  registry: CallRegistry;
  alerts: PhoneAlert[];
  logs: Array<{ msg: string; fields?: Record<string, unknown> }>;
  stop(): Promise<void>;
}

/** A real phone bridge — engine, registry, signed edge — fronting a real agentd. */
export async function startPhone(
  agent: RunningAgent,
  options: { dbPath?: string; warmUp?: boolean; operatorNumbers?: string[] } = {},
): Promise<RunningPhone> {
  const registry = new CallRegistry(options.dbPath ?? ":memory:");
  const alerts: PhoneAlert[] = [];
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger = {
    info: (msg: string, fields?: Record<string, unknown>) => void logs.push({ msg, fields }),
    warn: (msg: string, fields?: Record<string, unknown>) => void logs.push({ msg, fields }),
  };
  const agents: PhoneAgent[] = [{ name: agent.name, spokenName: "Hearth", aliases: ["home"], resumeWindowSeconds: 3600 }];
  const allowed = new Set(options.operatorNumbers ?? ["+15550100001"]);
  const client = new RemoteAgentClient(agent.url, netdFetch());
  const phone = buildPhoneServer({
    publicBaseUrl: PUBLIC,
    authToken: AUTH_TOKEN,
    relaySecret: RELAY_SECRET,
    registry,
    logger,
    alerts: { post: (a) => void alerts.push(a) },
    engineFor: (relay, engineAlerts) =>
      new CallEngine({
        agents,
        clientFor: () => client,
        relay,
        state: registry,
        alerts: engineAlerts,
        verifyPin: (digits) => digits === PIN,
        callerAllowed: (from) => allowed.has(from),
        warmUp: options.warmUp ?? false,
        dtmfBatchMs: 20,
        logger,
      }),
  });
  await new Promise<void>((resolve) => phone.server.listen(0, "127.0.0.1", () => resolve()));
  const address = phone.server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return {
    phone,
    port: address.port,
    registry,
    alerts,
    logs,
    stop: async () => {
      await phone.close();
      registry.close();
    },
  };
}

/** One entry of the call as the fake peer saw it, in wire order. */
export type TimelineEntry =
  | { dir: "in"; frame: Record<string, unknown> }
  | { dir: "out"; command: RelayCommand };

/**
 * Twilio's side of the socket, played by the test: connects with the
 * signature Twilio would carry, sends the recorded frames a scenario
 * asks for, and keeps every frame in both directions in one timeline so
 * ordering — a token after a cancel — is a plain assertion.
 */
export class FakeRelay {
  timeline: TimelineEntry[] = [];
  closed?: { code: number; reason: string };
  private ws?: WebSocket;

  static async connect(port: number, options: { signature?: string; path?: string } = {}): Promise<FakeRelay | { status: number }> {
    const relay = new FakeRelay();
    const path = options.path ?? `/relay/${RELAY_SECRET}`;
    const signature = options.signature ?? twilioSignature(AUTH_TOKEN, `wss://phone.example.net${path}`);
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { "x-twilio-signature": signature } });
      ws.on("open", () => {
        relay.ws = ws;
        resolve(relay);
      });
      ws.on("unexpected-response", (_req, res) => {
        resolve({ status: res.statusCode ?? 0 });
        ws.terminate();
      });
      ws.on("message", (data) => {
        relay.timeline.push({ dir: "out", command: JSON.parse(data.toString()) as RelayCommand });
      });
      ws.on("close", (code, reason) => {
        relay.closed = { code, reason: reason.toString() };
      });
      ws.on("error", () => resolve({ status: 0 }));
    });
  }

  send(frame: Record<string, unknown>): void {
    this.timeline.push({ dir: "in", frame });
    this.ws!.send(JSON.stringify(frame));
  }

  /** Recorded frames in order; with `speed`, the recorded gaps between them, divided. */
  async play(frames: RecordedFrame[], speed = Infinity): Promise<void> {
    let previous: number | undefined;
    for (const { ms, frame } of frames) {
      if (previous !== undefined && Number.isFinite(speed)) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, (ms - previous!) / speed)));
      }
      previous = ms;
      this.send(frame);
    }
  }

  /** Every command the bridge sent, in order. */
  commands(): RelayCommand[] {
    return this.timeline.flatMap((e) => (e.dir === "out" ? [e.command] : []));
  }

  texts(): Array<[string, boolean]> {
    return this.commands().flatMap((c) => (c.type === "text" ? [[c.token, c.last]] : []));
  }

  /** The spoken text of every complete utterance so far. */
  utterances(): string[] {
    const out: string[] = [];
    let current = "";
    for (const [token, last] of this.texts()) {
      current += token;
      if (last) {
        out.push(current);
        current = "";
      }
    }
    return out;
  }

  /** Commands received after the last sent frame of the given type. */
  commandsAfterLast(type: string): RelayCommand[] {
    let index = -1;
    this.timeline.forEach((e, i) => {
      if (e.dir === "in" && e.frame.type === type) index = i;
    });
    return this.timeline.slice(index + 1).flatMap((e) => (e.dir === "out" ? [e.command] : []));
  }

  /** Hang up from the caller's side: what Twilio does when the operator ends the call. */
  hangUp(): void {
    this.ws?.close(1000, "Closing websocket session");
  }

  /** The socket goes away without a word: the bridge sees a drop. */
  drop(): void {
    this.ws?.terminate();
  }
}

/** A signed webhook POST, as Twilio would send it. */
export function postWebhook(port: number, path: string, form: Record<string, string>): Promise<{ status: number; body: string }> {
  const body = new URLSearchParams(form).toString();
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    "content-length": String(Buffer.byteLength(body)),
    "x-twilio-signature": twilioSignature(AUTH_TOKEN, `${PUBLIC}${path}`, form),
  };
  return new Promise((resolve, reject) => {
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
