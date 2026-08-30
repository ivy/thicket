import { TaskState, type Message, type Task } from "@a2a-js/sdk";
import type { A2AEvent, AgentClient } from "@thicket/a2a-client";
import {
  META_PHONE_CALL,
  META_PHONE_DIRECTION,
  META_PHONE_FROM,
  META_PHONE_KIND,
  META_PHONE_SESSION_STARTED,
  META_PHONE_TO,
  META_SHOULD_QUERY,
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
  | { kind: "caller_rejected"; callSid: string; from: string; reason: "unlisted" | "locked"; untilMs?: number }
  | { kind: "auth_failed"; callSid: string; from: string; attempt: number; final: boolean }
  | { kind: "locked_out"; callSid: string; from: string; untilMs: number }
  | { kind: "session_started"; callSid: string; agent: string; contextId: string; resumed: boolean }
  | { kind: "session_ended"; callSid: string; agent: string; durationMs: number; reason: SessionEnd };

/** How a session came to an end. */
export type SessionEnd = "goodbye" | "switched" | "dropped";

export interface AlertPort {
  post(alert: PhoneAlert): void | Promise<void>;
}

export interface Clock {
  now(): number;
}

/** Failed calls per number, remembered across calls and restarts by the registry. */
export interface LockoutPort {
  /** When the number's lockout ends, if it is under one. */
  lockedUntil(from: string): number | undefined;
  /** A call ran out of attempts; returns when the lockout ends if this one locked the number. */
  failedCall(from: string): number | undefined;
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
  lockout?: LockoutPort;
  maxPinAttempts?: number;
  /** How long after the last key a batch of digits is sent as one message. */
  dtmfBatchMs?: number;
  /**
   * Send the agent a context-only message the moment a session connects,
   * so its subprocess is warm before the operator finishes speaking. Off
   * by default here; the bridge's config turns it on.
   */
  warmUp?: boolean;
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
  /** The stopwatch: from the finalized prompt to the agent's first chunk and to the first token Twilio got. */
  startedAt: number;
  firstChunkAt?: number;
  firstTokenAt?: number;
}

/** One turn's latencies, in ms from the finalized prompt. */
export interface TurnLatency {
  seq: number;
  toFirstChunkMs?: number;
  toFirstTokenMs?: number;
  totalMs: number;
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein distance, for names heard a letter or two off. */
function editDistance(a: string, b: string): number {
  const row: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** The text a task produced: its status message, else its text artifacts. */
function taskText(task: Task): string {
  const text = (parts: { content?: { $case: string; value: unknown } }[] | undefined) =>
    (parts ?? []).map((part) => (part.content?.$case === "text" ? String(part.content.value) : "")).join("");
  const fromStatus = text(task.status?.message?.parts);
  if (fromStatus !== "") {
    return fromStatus;
  }
  return task.artifacts.map((artifact) => text(artifact.parts)).join("");
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
  /** In `choosing`: a name that was close to an agent's but not it — asked, never assumed. */
  private confirmOffer?: PhoneAgent;
  /** What a task finished while the operator was away, for "what did I miss". */
  private awaySummary?: string;
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
  private readonly lockout: LockoutPort | undefined;
  private readonly maxPinAttempts: number;
  private readonly dtmfBatchMs: number;
  private readonly warmUp: boolean;
  /** Every finished turn's stopwatch, for the summary at the end of the call. */
  readonly latencies: TurnLatency[] = [];
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
    this.lockout = options.lockout;
    this.maxPinAttempts = options.maxPinAttempts ?? 3;
    this.dtmfBatchMs = options.dtmfBatchMs ?? 1500;
    this.warmUp = options.warmUp ?? false;
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

  /** The call is over — by goodbye, by switching agent, or because the socket went away: close the books, keep the session. */
  async hangup(reason: SessionEnd = "dropped"): Promise<void> {
    if (this.state === "ending") {
      return;
    }
    this.state = "ending";
    this.cancelKeyFlush?.();
    const connected = this.connected;
    const call = this.call;
    if (connected !== undefined && call !== undefined) {
      const now = this.clock.now();
      const running = this.turn !== undefined && !this.turn.dropped ? this.turn.taskId : undefined;
      this.store.saveSession({
        agent: connected.agent.name,
        contextId: connected.contextId,
        openedByCall: this.store.sessionFor(connected.agent.name)?.openedByCall ?? call.callSid,
        lastActiveAt: now,
        ...(connected.awaitingInputTaskId === undefined ? {} : { openTaskId: connected.awaitingInputTaskId }),
        ...(running === undefined ? {} : { runningTaskId: running }),
      });
      await this.alert({
        kind: "session_ended",
        callSid: call.callSid,
        agent: connected.agent.name,
        durationMs: now - connected.startedAt,
        reason,
      });
    }
    if (this.turn !== undefined) {
      // The task keeps running in agentd; only the forwarding stops.
      this.turn.dropped = true;
    }
    this.connected = undefined;
    if (this.latencies.length > 0) {
      const chunks = this.latencies.flatMap((l) => (l.toFirstChunkMs === undefined ? [] : [l.toFirstChunkMs]));
      const tokens = this.latencies.flatMap((l) => (l.toFirstTokenMs === undefined ? [] : [l.toFirstTokenMs]));
      this.logger.info("call latency", {
        callSid: call?.callSid,
        turns: this.latencies.length,
        warmUp: this.warmUp,
        medianToFirstChunkMs: percentile(chunks, 50),
        p90ToFirstChunkMs: percentile(chunks, 90),
        medianToFirstTokenMs: percentile(tokens, 50),
        p90ToFirstTokenMs: percentile(tokens, 90),
      });
    }
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
      await this.alert({ kind: "caller_rejected", callSid: event.callSid, from: event.from, reason: "unlisted" });
      this.state = "ending";
      await this.relay.send(endSession("rejected"));
      return;
    }
    const untilMs = this.lockout?.lockedUntil(event.from);
    if (untilMs !== undefined) {
      // A listed number that keeps failing is treated like a stranger until the cooldown ends.
      await this.alert({ kind: "caller_rejected", callSid: event.callSid, from: event.from, reason: "locked", untilMs });
      this.state = "ending";
      await this.relay.send(endSession("locked-out"));
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
      const lockedUntil = this.lockout?.failedCall(call.from);
      if (lockedUntil !== undefined) {
        await this.alert({ kind: "locked_out", callSid: call.callSid, from: call.from, untilMs: lockedUntil });
      }
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

  private handles(agent: PhoneAgent): string[] {
    return [agent.spokenName, agent.name, ...agent.aliases].map(normalize);
  }

  private agentNamed(text: string): PhoneAgent | undefined {
    const words = ` ${normalize(text)} `;
    return this.agents.find((agent) => this.handles(agent).some((handle) => words.includes(` ${handle} `)));
  }

  /**
   * The nearest agent to what was heard, when no handle matched outright:
   * a word within a couple of edits of a spoken name. Offered for
   * confirmation, never connected on its own — a misheard name routed to
   * the wrong agent is the one mistake the picker must not make.
   */
  private agentNearlyNamed(text: string): PhoneAgent | undefined {
    const words = normalize(text)
      .split(" ")
      .filter((word) => word.length >= 3);
    let best: { agent: PhoneAgent; distance: number } | undefined;
    for (const agent of this.agents) {
      for (const handle of this.handles(agent)) {
        for (const word of words) {
          if (Math.abs(word.length - handle.length) > 2) {
            continue;
          }
          const distance = editDistance(word, handle);
          // One edit for a short name, two for a longer one: "hurth" is
          // Hearth, "forj" is Forge, and "one" is not "home".
          const allowed = Math.max(1, Math.floor(handle.length / 2.5));
          if (distance <= allowed && (best === undefined || distance < best.distance)) {
            best = { agent, distance };
          }
        }
      }
    }
    return best?.agent;
  }

  private async onChoice(text: string): Promise<void> {
    const said = normalize(text);
    const confirm = this.confirmOffer;
    if (confirm !== undefined) {
      this.confirmOffer = undefined;
      if (/\b(yes|yeah|yep|correct|right|that s it)\b/.test(said)) {
        await this.choose(confirm);
        return;
      }
      if (/\b(no|nope|wrong)\b/.test(said)) {
        await this.speak(this.offer());
        return;
      }
      // Anything else is a fresh attempt at the name.
    }
    const offer = this.resumeOffer;
    if (offer !== undefined) {
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
    if (agent !== undefined) {
      await this.choose(agent);
      return;
    }
    const nearly = this.agentNearlyNamed(text);
    if (nearly !== undefined) {
      this.confirmOffer = nearly;
      await this.speak(`Did you say ${nearly.spokenName}?`);
      return;
    }
    await this.speak(`I didn't catch that. ${this.offer()}`);
  }

  /** An agent was named for certain: offer the recent session, or connect. */
  private async choose(agent: PhoneAgent): Promise<void> {
    const previous = this.store.sessionFor(agent.name);
    const withinWindow =
      previous !== undefined && this.clock.now() - previous.lastActiveAt <= agent.resumeWindowSeconds * 1000;
    if (previous === undefined || !withinWindow) {
      await this.connect(agent, undefined);
      return;
    }
    this.resumeOffer = { agent, session: previous };
    const minutes = Math.max(1, Math.round((this.clock.now() - previous.lastActiveAt) / 60_000));
    const when = minutes === 1 ? "a minute" : `${minutes} minutes`;
    await this.speak(`You were talking to ${agent.spokenName} ${when} ago.${await this.taskSince(agent, previous)} Resume, or start fresh?`);
  }

  /** What the agent's task did since the call ended, from the task store: a clause for the offer, or nothing. */
  private async taskSince(agent: PhoneAgent, previous: PhoneSession): Promise<string> {
    const taskId = previous.runningTaskId ?? previous.openTaskId;
    if (taskId === undefined) {
      return "";
    }
    const task = await this.fetchTask(agent, taskId);
    if (task === undefined) {
      return "";
    }
    switch (task.status?.state) {
      case TaskState.TASK_STATE_WORKING:
      case TaskState.TASK_STATE_SUBMITTED:
        return " It's still working on what you asked.";
      case TaskState.TASK_STATE_INPUT_REQUIRED:
        return " It's waiting on an answer from you.";
      case TaskState.TASK_STATE_COMPLETED:
        return " It finished what you asked while you were away.";
      case TaskState.TASK_STATE_FAILED:
        return " What you asked failed while you were away.";
      default:
        return "";
    }
  }

  private async fetchTask(agent: PhoneAgent, taskId: string): Promise<Task | undefined> {
    const client = this.clientFor(agent.name);
    if (client.getTask === undefined) {
      return undefined;
    }
    try {
      return await client.getTask(taskId);
    } catch (err) {
      this.logger.warn("task lookup failed", { taskId, err: String(err) });
      return undefined;
    }
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
    if (this.warmUp) {
      void this.warm(agent, contextId);
    }
    await this.speak(previous === undefined ? `Connected to ${agent.spokenName}.` : `Resuming with ${agent.spokenName}.`);
    if (previous?.runningTaskId !== undefined) {
      await this.pickUp(agent, previous.runningTaskId);
    }
  }

  /**
   * A context-only message: the executor appends it to the transcript
   * without a turn, and spawning the subprocess to do so is the point —
   * the first real prompt then meets a warm session.
   */
  private async warm(agent: PhoneAgent, contextId: string): Promise<void> {
    const call = this.call!;
    const message: Message = {
      messageId: `${phoneMessageId(call.callSid, 0)}-warm`,
      contextId,
      taskId: "",
      role: 1,
      parts: [textPart("The operator has connected by phone.")],
      metadata: {
        [META_SHOULD_QUERY]: false,
        [META_TRIGGER]: TRIGGER_PHONE,
        [META_PHONE_CALL]: call.callSid,
        [META_PHONE_FROM]: call.from,
        [META_PHONE_TO]: call.to,
        [META_PHONE_DIRECTION]: call.direction,
        [META_PHONE_KIND]: "event",
        [META_PHONE_SESSION_STARTED]: new Date(this.connected?.startedAt ?? this.clock.now()).toISOString(),
      },
      extensions: [],
      referenceTaskIds: [],
    };
    try {
      await this.clientFor(agent.name).send(message);
      this.logger.info("session warmed", { agent: agent.name });
    } catch (err) {
      this.logger.warn("warm-up failed", { agent: agent.name, err: String(err) });
    }
  }

  /**
   * Back on a session whose task was still running when the call ended:
   * if it still is, re-attach and speak the rest of its output; if it
   * finished meanwhile, speak what it produced. From the task store, so
   * nothing depends on this process having been the one that started it.
   */
  private async pickUp(agent: PhoneAgent, taskId: string): Promise<void> {
    const task = await this.fetchTask(agent, taskId);
    if (task === undefined) {
      return;
    }
    const state = task.status?.state;
    if (state === TaskState.TASK_STATE_WORKING || state === TaskState.TASK_STATE_SUBMITTED) {
      await this.speak("It's still working. Here's the rest as it comes.");
      this.seq += 1;
      const turn: Turn = { seq: this.seq, taskId, spoken: "", dropped: false, done: Promise.resolve(), startedAt: this.clock.now() };
      turn.done = this.forward(turn, this.clientFor(agent.name).resubscribe(taskId), agent);
      this.turn = turn;
      return;
    }
    if (state === TaskState.TASK_STATE_INPUT_REQUIRED) {
      this.connected!.awaitingInputTaskId = taskId;
      const question = taskText(task);
      await this.speak(question === "" ? "It's waiting on an answer from you." : `It asked: ${question}`);
      return;
    }
    const produced = taskText(task);
    if (state === TaskState.TASK_STATE_COMPLETED && produced !== "") {
      this.awaySummary = produced;
      await this.speak(`While you were away, it finished: ${produced}`);
    } else if (state === TaskState.TASK_STATE_FAILED) {
      await this.speak("What you asked failed while you were away.");
    }
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
      await this.hangup("goodbye");
      return;
    }
    const switching = /^(?:(?:switch|change)(?: agents?)?(?: to)?|put me through to|connect me to|transfer me to)(?: (.+))?$/.exec(said);
    if (switching !== null) {
      await this.hangup("switched");
      this.state = "choosing";
      if (switching[1] === undefined) {
        await this.speak(this.offer());
      } else {
        await this.onChoice(switching[1]);
      }
      return;
    }
    if (/^(what did i miss|what happened|what did it do)$/.test(said)) {
      await this.speak(this.awaySummary === undefined ? "Nothing since you left." : `While you were away, it finished: ${this.awaySummary}`);
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
    const turn: Turn = { seq: this.seq, spoken: "", dropped: false, done: Promise.resolve(), startedAt: this.clock.now() };
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
    await this.forward(turn, client.stream(message), connected.agent);
  }

  /** Speak a stream of task events until it ends, or until the turn is dropped. */
  private async forward(turn: Turn, events: AsyncIterable<A2AEvent>, agent: PhoneAgent): Promise<void> {
    try {
      for await (const event of events) {
        if (turn.dropped) {
          continue; // drain, forward nothing
        }
        await this.onTurnEvent(turn, event);
      }
    } catch (err) {
      this.logger.warn("turn failed", { seq: turn.seq, err: String(err) });
      if (!turn.dropped) {
        await this.speak(`Something went wrong talking to ${agent.spokenName}.`);
      }
    } finally {
      if (this.turn === turn) {
        this.turn = undefined;
      }
      this.clockTurn(turn);
    }
  }

  /** One log line per turn with its stopwatch; dropped turns are logged but not counted. */
  private clockTurn(turn: Turn): void {
    const now = this.clock.now();
    const latency: TurnLatency = {
      seq: turn.seq,
      ...(turn.firstChunkAt === undefined ? {} : { toFirstChunkMs: turn.firstChunkAt - turn.startedAt }),
      ...(turn.firstTokenAt === undefined ? {} : { toFirstTokenMs: turn.firstTokenAt - turn.startedAt }),
      totalMs: now - turn.startedAt,
    };
    this.logger.info("turn latency", { ...latency, dropped: turn.dropped, chars: turn.spoken.length });
    if (!turn.dropped) {
      this.latencies.push(latency);
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
        turn.firstChunkAt ??= this.clock.now();
        // Hold one chunk back: the final token must carry `last`, and the
        // stream only says which chunk was final once the task is terminal.
        if (turn.held !== undefined) {
          await this.relay.send(say(turn.held, false));
          turn.firstTokenAt ??= this.clock.now();
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
          turn.firstTokenAt ??= this.clock.now();
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
