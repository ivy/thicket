import { TaskState, type Message } from "@a2a-js/sdk";
import type { A2AEvent, AgentClient } from "@thicket/a2a-client";
import {
  META_PHONE_CALL,
  META_PHONE_DIRECTION,
  META_PHONE_FROM,
  META_PHONE_KIND,
  META_PHONE_SESSION_STARTED,
  META_PHONE_TO,
  META_TRIGGER,
  TRIGGER_PHONE,
  uuidv5,
  type PhoneMessageKind,
} from "@thicket/executor";
import type { PhoneAgent } from "@thicket/roster";

import { endSession, say, type CallEvent, type RelayCommand } from "./codec.js";
import type { PhoneSession, PhoneStatePort } from "./state.js";

/** The socket side, as the engine sees it: commands out, nothing else. */
export interface RelayPort {
  send(command: RelayCommand): void | Promise<void>;
}

/** The oversight surface. Best-effort: a failed post never affects the call. */
export type PhoneAlert =
  | { kind: "caller_rejected"; callSid: string; from: string }
  | { kind: "auth_failed"; callSid: string; from: string; attempt: number; final: boolean }
  | { kind: "session_started"; callSid: string; agent: string; contextId: string; resumed: boolean }
  | { kind: "session_ended"; callSid: string; agent: string; durationMs: number };

export interface AlertPort {
  post(alert: PhoneAlert): void | Promise<void>;
}

export interface Clock {
  now(): number;
}

/** Deferred work, injectable so tests can fire it by hand. Returns a cancel. */
export interface Scheduler {
  schedule(ms: number, fn: () => void): () => void;
}

export interface EngineLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface CallEngineOptions {
  /** The roster's phone-enabled agents, in the order Aiva offers them. */
  agents: PhoneAgent[];
  clientFor(agent: string): AgentClient;
  relay: RelayPort;
  state: PhoneStatePort;
  alerts: AlertPort;
  /** The PIN policy's compare (constant-time, against the config); the engine only counts attempts. */
  verifyPin(digits: string): boolean;
  /** The allow-list pre-filter. Never authority: the PIN is. */
  callerAllowed(from: string): boolean;
  maxPinAttempts?: number;
  /** How long after the last key a batch of digits is sent as one message. */
  dtmfBatchMs?: number;
  clock?: Clock;
  scheduler?: Scheduler;
  logger?: EngineLogger;
}

/**
 * Where a call is. Nothing is spoken before `choosing`; nothing reaches an
 * agent before `connected`. There is no greeting state: the PIN arrives as
 * the first thing on the wire, and Aiva's hello is the entry to `choosing`.
 */
export type CallState = "idle" | "authenticating" | "choosing" | "connected" | "ending";

const PIN_LENGTH = 8;

/** A phone session's contextId: the agent and the call that opened it, nothing stored. */
export function phoneSessionId(agent: string, openingCallSid: string): string {
  return uuidv5(`phone:${agent}:${openingCallSid}`);
}

/** Per call, in sequence, so a resumed session's messages still say which call they came from. */
export function phoneMessageId(callSid: string, seq: number): string {
  return `phone-${callSid}-${seq}`;
}

interface Call {
  callSid: string;
  from: string;
  to: string;
  direction: string;
  startedAt: number;
}

interface Connected {
  agent: PhoneAgent;
  contextId: string;
  startedAt: number;
  /** A task that asked the operator a question; the next message continues it. */
  awaitingInputTaskId?: string;
}

interface Turn {
  seq: number;
  taskId?: string;
  /** The chunk held back so the final token can carry `last`. */
  held?: string;
  spoken: string;
  /** Set by an interrupt or a newer utterance: forward nothing more from this turn. */
  dropped: boolean;
  done: Promise<void>;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textPart(text: string) {
  return { content: { $case: "text" as const, value: text }, mediaType: "text/plain", filename: "", metadata: {} };
}

/**
 * One call, from `setup` to hangup, driven by events the codec produced.
 * Everything with a side effect goes through a port, so a fake peer can
 * replay recorded frames and read back exactly what would have been sent.
 */
export class CallEngine {
  state: CallState = "idle";
  private call?: Call;
  private connected?: Connected;
  private pin = "";
  private pinAttempts = 0;
  /** In `choosing`: an agent named whose earlier session is on offer. */
  private resumeOffer?: { agent: PhoneAgent; session: PhoneSession };
  private seq = 0;
  private turn?: Turn;
  private lastReply = "";
  private interruptedAt?: string;
  private keys = "";
  private cancelKeyFlush?: () => void;

  private readonly agents: PhoneAgent[];
  private readonly clientFor: (agent: string) => AgentClient;
  private readonly relay: RelayPort;
  private readonly store: PhoneStatePort;
  private readonly alerts: AlertPort;
  private readonly verifyPin: (digits: string) => boolean;
  private readonly callerAllowed: (from: string) => boolean;
  private readonly maxPinAttempts: number;
  private readonly dtmfBatchMs: number;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly logger: EngineLogger;

  constructor(options: CallEngineOptions) {
    this.agents = options.agents;
    this.clientFor = options.clientFor;
    this.relay = options.relay;
    this.store = options.state;
    this.alerts = options.alerts;
    this.verifyPin = options.verifyPin;
    this.callerAllowed = options.callerAllowed;
    this.maxPinAttempts = options.maxPinAttempts ?? 3;
    this.dtmfBatchMs = options.dtmfBatchMs ?? 1500;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.scheduler = options.scheduler ?? {
      schedule: (ms, fn) => {
        const handle = setTimeout(fn, ms);
        return () => clearTimeout(handle);
      },
    };
    this.logger = options.logger ?? { info: () => {}, warn: () => {} };
  }

  /** The open turn's completion, for callers that need the stream drained. */
  async idle(): Promise<void> {
    await this.turn?.done;
  }

  async handle(event: CallEvent): Promise<void> {
    switch (this.state) {
      case "idle":
        if (event.kind === "setup") {
          await this.onSetup(event);
        }
        return;
      case "authenticating":
        // Speech before authentication is discarded: only keys count here.
        if (event.kind === "key") {
          await this.onPinDigit(event.digit);
        }
        return;
      case "choosing":
        if (event.kind === "speech" && event.final) {
          await this.onChoice(event.text);
        }
        return;
      case "connected":
        await this.onConnectedEvent(event);
        return;
      case "ending":
        return;
    }
  }

  /** The caller hung up, or the socket went away: close the books, keep the session. */
  async hangup(): Promise<void> {
    if (this.state === "ending") {
      return;
    }
    this.state = "ending";
    this.cancelKeyFlush?.();
    if (this.turn !== undefined) {
      // The task keeps running in agentd; only the forwarding stops.
      this.turn.dropped = true;
    }
    const connected = this.connected;
    const call = this.call;
    if (connected !== undefined && call !== undefined) {
      const now = this.clock.now();
      this.store.saveSession({
        agent: connected.agent.name,
        contextId: connected.contextId,
        openedByCall: this.store.sessionFor(connected.agent.name)?.openedByCall ?? call.callSid,
        lastActiveAt: now,
        ...(connected.awaitingInputTaskId === undefined ? {} : { openTaskId: connected.awaitingInputTaskId }),
      });
      await this.alert({
        kind: "session_ended",
        callSid: call.callSid,
        agent: connected.agent.name,
        durationMs: now - connected.startedAt,
      });
    }
    this.connected = undefined;
  }

  // ---------------------------------------------------------------- authenticating

  private async onSetup(event: Extract<CallEvent, { kind: "setup" }>): Promise<void> {
    this.call = {
      callSid: event.callSid,
      from: event.from,
      to: event.to,
      direction: event.direction,
      startedAt: this.clock.now(),
    };
    if (!this.callerAllowed(event.from)) {
      // Not a word: an unknown caller learns nothing about what answered.
      await this.alert({ kind: "caller_rejected", callSid: event.callSid, from: event.from });
      this.state = "ending";
      await this.relay.send(endSession("rejected"));
      return;
    }
    this.state = "authenticating";
  }

  private async onPinDigit(digit: string): Promise<void> {
    if (digit === "#" || digit === "*") {
      if (this.pin.length === 0) {
        return; // a terminator after the eighth digit, or a stray key
      }
    } else {
      this.pin += digit;
      if (this.pin.length < PIN_LENGTH) {
        return;
      }
    }
    const entered = this.pin;
    this.pin = "";
    const call = this.call!;
    if (this.verifyPin(entered)) {
      this.pinAttempts = 0;
      this.state = "choosing";
      await this.speak(`Hi, it's Aiva. ${this.offer()}`);
      return;
    }
    this.pinAttempts += 1;
    const final = this.pinAttempts >= this.maxPinAttempts;
    await this.alert({ kind: "auth_failed", callSid: call.callSid, from: call.from, attempt: this.pinAttempts, final });
    if (final) {
      this.state = "ending";
      await this.speak("That's not it. Goodbye.");
      await this.relay.send(endSession("auth-failed"));
      return;
    }
    await this.speak("That's not it. Try again.");
  }

  // ---------------------------------------------------------------- choosing

  private offer(): string {
    const names = this.agents.map((a) => a.spokenName);
    if (names.length === 0) {
      return "No agent is on the phone right now.";
    }
    if (names.length === 1) {
      return `Shall I connect you to ${names[0]}?`;
    }
    return `Who would you like? ${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}.`;
  }

  private agentNamed(text: string): PhoneAgent | undefined {
    const words = ` ${normalize(text)} `;
    return this.agents.find((agent) =>
      [agent.spokenName, agent.name, ...agent.aliases].some((handle) => words.includes(` ${normalize(handle)} `)),
    );
  }

  private async onChoice(text: string): Promise<void> {
    const offer = this.resumeOffer;
    if (offer !== undefined) {
      const said = normalize(text);
      if (/\b(resume|continue|pick up|carry on|yes)\b/.test(said)) {
        this.resumeOffer = undefined;
        await this.connect(offer.agent, offer.session);
        return;
      }
      if (/\b(new|fresh|start over|no)\b/.test(said)) {
        this.resumeOffer = undefined;
        await this.connect(offer.agent, undefined);
        return;
      }
      await this.speak("Resume, or start fresh?");
      return;
    }
    const agent = this.agentNamed(text);
    if (agent === undefined) {
      await this.speak(`I didn't catch that. ${this.offer()}`);
      return;
    }
    const previous = this.store.sessionFor(agent.name);
    const withinWindow =
      previous !== undefined && this.clock.now() - previous.lastActiveAt <= agent.resumeWindowSeconds * 1000;
    if (previous !== undefined && withinWindow) {
      this.resumeOffer = { agent, session: previous };
      const minutes = Math.max(1, Math.round((this.clock.now() - previous.lastActiveAt) / 60_000));
      await this.speak(
        `You were talking to ${agent.spokenName} ${minutes === 1 ? "a minute" : `${minutes} minutes`} ago. Resume, or start fresh?`,
      );
      return;
    }
    await this.connect(agent, undefined);
  }

  private async connect(agent: PhoneAgent, previous: PhoneSession | undefined): Promise<void> {
    const call = this.call!;
    const now = this.clock.now();
    const contextId = previous?.contextId ?? phoneSessionId(agent.name, call.callSid);
    this.connected = {
      agent,
      contextId,
      startedAt: now,
      ...(previous?.openTaskId === undefined ? {} : { awaitingInputTaskId: previous.openTaskId }),
    };
    this.store.saveSession({
      agent: agent.name,
      contextId,
      openedByCall: previous?.openedByCall ?? call.callSid,
      lastActiveAt: now,
    });
    this.state = "connected";
    await this.alert({
      kind: "session_started",
      callSid: call.callSid,
      agent: agent.name,
      contextId,
      resumed: previous !== undefined,
    });
    await this.speak(previous === undefined ? `Connected to ${agent.spokenName}.` : `Resuming with ${agent.spokenName}.`);
  }

  // ---------------------------------------------------------------- connected

  private async onConnectedEvent(event: CallEvent): Promise<void> {
    switch (event.kind) {
      case "speech":
        if (event.final) {
          await this.onUtterance(event.text);
        }
        return;
      case "key":
        this.onKey(event.digit);
        return;
      case "interrupt":
        await this.onInterrupt(event.heard);
        return;
      case "relay-error":
        this.logger.warn("relay error", { description: event.description });
        return;
      default:
        return;
    }
  }

  /** Control phrases are handled here without a turn; anything else is one. */
  private async onUtterance(text: string): Promise<void> {
    const said = normalize(text);
    if (/^(goodbye|bye|hang up|that s all|that is all)$/.test(said)) {
      await this.speak("Goodbye.");
      await this.relay.send(endSession("goodbye"));
      await this.hangup();
      return;
    }
    if (/^(switch|change) agents?$/.test(said)) {
      await this.hangup();
      this.state = "choosing";
      await this.speak(this.offer());
      return;
    }
    if (/^(repeat that|say that again|again)$/.test(said)) {
      await this.speak(this.lastReply === "" ? "I haven't said anything yet." : this.lastReply);
      return;
    }
    if (/^status$/.test(said)) {
      await this.speak(this.turn !== undefined && !this.turn.dropped ? "Still working on it." : "Nothing is running.");
      return;
    }
    const heard = this.interruptedAt;
    this.interruptedAt = undefined;
    const kind: PhoneMessageKind = heard === undefined ? "speech" : "interrupted";
    const body = heard === undefined ? text : `[You were interrupted after saying: "${heard}"] ${text}`;
    this.startTurn(body, kind);
  }

  private onKey(digit: string): void {
    this.keys += digit;
    this.cancelKeyFlush?.();
    this.cancelKeyFlush = this.scheduler.schedule(this.dtmfBatchMs, () => {
      const digits = this.keys;
      this.keys = "";
      this.cancelKeyFlush = undefined;
      if (digits !== "" && this.state === "connected") {
        this.startTurn(digits, "dtmf");
      }
    });
  }

  private async onInterrupt(heard: string): Promise<void> {
    const turn = this.turn;
    if (turn === undefined || turn.dropped) {
      return;
    }
    turn.dropped = true;
    this.interruptedAt = heard;
    if (turn.taskId !== undefined) {
      await this.cancelTask(turn.taskId);
    }
  }

  private async cancelTask(taskId: string): Promise<void> {
    try {
      await this.clientFor(this.connected!.agent.name).cancel(taskId);
    } catch (err) {
      // The turn may have ended on its own a moment earlier; that is not a failure.
      this.logger.warn("cancel after the turn ended", { taskId, err: String(err) });
    }
  }

  /**
   * One utterance is one task. A turn still streaming when the next
   * utterance arrives is dropped and cancelled first: two replies
   * interleaved into one TTS queue would be gibberish.
   */
  private startTurn(text: string, kind: PhoneMessageKind): void {
    const previous = this.turn;
    if (previous !== undefined && !previous.dropped) {
      previous.dropped = true;
      if (previous.taskId !== undefined) {
        void this.cancelTask(previous.taskId);
      }
    }
    this.seq += 1;
    const turn: Turn = { seq: this.seq, spoken: "", dropped: false, done: Promise.resolve() };
    turn.done = this.runTurn(turn, this.buildMessage(text, kind));
    this.turn = turn;
  }

  private buildMessage(text: string, kind: PhoneMessageKind): Message {
    const call = this.call!;
    const connected = this.connected!;
    const continuing = connected.awaitingInputTaskId;
    connected.awaitingInputTaskId = undefined;
    return {
      messageId: phoneMessageId(call.callSid, this.seq),
      contextId: connected.contextId,
      taskId: continuing ?? "",
      role: 1,
      parts: [textPart(text)],
      metadata: {
        [META_TRIGGER]: TRIGGER_PHONE,
        [META_PHONE_CALL]: call.callSid,
        [META_PHONE_FROM]: call.from,
        [META_PHONE_TO]: call.to,
        [META_PHONE_DIRECTION]: call.direction,
        [META_PHONE_KIND]: kind,
        [META_PHONE_SESSION_STARTED]: new Date(connected.startedAt).toISOString(),
      },
      extensions: [],
      referenceTaskIds: [],
    };
  }

  private async runTurn(turn: Turn, message: Message): Promise<void> {
    const connected = this.connected!;
    const client = this.clientFor(connected.agent.name);
    try {
      for await (const event of client.stream(message)) {
        if (turn.dropped) {
          continue; // drain, forward nothing
        }
        await this.onTurnEvent(turn, event);
      }
    } catch (err) {
      this.logger.warn("turn failed", { seq: turn.seq, err: String(err) });
      if (!turn.dropped) {
        await this.speak(`Something went wrong talking to ${connected.agent.spokenName}.`);
      }
    } finally {
      if (this.turn === turn) {
        this.turn = undefined;
      }
    }
  }

  private async onTurnEvent(turn: Turn, event: A2AEvent): Promise<void> {
    switch (event.kind) {
      case "task":
        turn.taskId = event.task.id;
        return;
      case "artifact": {
        if (event.text === "") {
          return;
        }
        // Hold one chunk back: the final token must carry `last`, and the
        // stream only says which chunk was final once the task is terminal.
        if (turn.held !== undefined) {
          await this.relay.send(say(turn.held, false));
          turn.spoken += turn.held;
        }
        turn.held = event.text;
        return;
      }
      case "status": {
        const terminal =
          event.state === TaskState.TASK_STATE_COMPLETED ||
          event.state === TaskState.TASK_STATE_FAILED ||
          event.state === TaskState.TASK_STATE_CANCELED ||
          event.state === TaskState.TASK_STATE_INPUT_REQUIRED;
        if (!terminal) {
          return;
        }
        if (event.state === TaskState.TASK_STATE_INPUT_REQUIRED && event.taskId !== "") {
          this.connected!.awaitingInputTaskId = event.taskId;
        }
        const closing = turn.held ?? "";
        const trailing = turn.held === undefined ? (event.messageText ?? "") : "";
        const finalToken = closing + trailing;
        turn.held = undefined;
        if (finalToken !== "") {
          await this.relay.send(say(finalToken, true));
          turn.spoken += finalToken;
        } else if (turn.spoken !== "") {
          // Everything was already sent without `last`; close the utterance.
          await this.relay.send(say("", true));
        }
        if (turn.spoken !== "") {
          this.lastReply = turn.spoken;
        }
        return;
      }
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- helpers

  private async speak(text: string): Promise<void> {
    this.lastReply = text;
    await this.relay.send(say(text, true));
  }

  private async alert(alert: PhoneAlert): Promise<void> {
    try {
      await this.alerts.post(alert);
    } catch (err) {
      this.logger.warn("alert not posted", { kind: alert.kind, err: String(err) });
    }
  }
}
