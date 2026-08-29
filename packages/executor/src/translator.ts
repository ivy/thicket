import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Role, TaskState } from "@a2a-js/sdk";
import type { Artifact, Message, TaskStatus } from "@a2a-js/sdk";
import { AgentEvent } from "@a2a-js/sdk/server";
import type { AgentExecutionEvent } from "@a2a-js/sdk/server";

import {
  ACTIVITY_ARTIFACT_ID,
  ACTIVITY_MEDIA_TYPE,
  activity,
  describeToolUse,
  type AgentActivity,
  type AgentActivityStatus,
  type ToolDescription,
} from "./activity.js";
import { META_QUESTIONS, parseAgentQuestions } from "./questions.js";
import {
  META_FOLDED_INTO,
  META_FOLDED_MESSAGE_IDS,
  META_QUEUED_TURN_COUNT,
  META_TRIGGER,
  type PendingSend,
} from "./types.js";

export const ASSISTANT_TEXT_ARTIFACT_ID = "assistant-text";

function stateName(state: TaskState): TurnAccounting["state"] {
  switch (state) {
    case TaskState.TASK_STATE_COMPLETED:
      return "completed";
    case TaskState.TASK_STATE_CANCELED:
      return "canceled";
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return "input-required";
    default:
      return "failed";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface TranslatorOptions {
  publish: (event: AgentExecutionEvent) => void;
  /** Injectable clock so golden tests are deterministic. */
  now?: () => string;
  /** Diagnostic sink for frames the translator cannot act on. */
  onWarning?: (message: string) => void;
  /** Called once per settled turn with its accounting (task 025). */
  onTurnResult?: (record: TurnAccounting) => void;
}

/**
 * One turn's accounting, assembled from the result frame. Cost and token
 * fields are per-turn deltas: the SDK reports running totals per
 * subprocess generation, so the baseline resets on every system/init
 * frame. Metadata only, by decision — no prompt or reply text.
 */
export interface TurnAccounting {
  taskId: string;
  contextId: string;
  /** What triggered the turn: message metadata's thicket.trigger, else "human". */
  trigger: string;
  state: "completed" | "failed" | "canceled" | "input-required";
  durationMs: number;
  durationApiMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Distinct tool names the turn used, in first-use order. */
  toolsUsed: string[];
  /** Tool names whose use was denied. */
  permissionDenials: string[];
  error?: string;
  queuedTurnCount: number;
}

/** The fields a card keeps when its status changes. */
type OpenCard = Pick<ToolDescription, "title" | "icon">;

interface OpenTurn {
  send: PendingSend;
  /** Registration sequence at the moment the turn opened: sends
   * registered after this cannot have been coalesced into it. */
  openSeq: number;
  /** Text already emitted as artifact chunks (concatenated). */
  emittedText: string;
  /** Held-back chunk, flushed by the next chunk or the result. */
  pendingChunk: string | null;
  chunksEmitted: number;
  /** Set when stream deltas carried text, so complete-message frames are not double-counted. */
  sawStreamText: boolean;
  /** Open tool cards: tool_use_id -> what to redraw them with, awaiting their tool_result. */
  openTools: Map<string, OpenCard>;
  /** Distinct tool names used this turn, for the journal. */
  toolNames: Set<string>;
  activityEmitted: number;
  interrupted: boolean;
  terminalEmitted: boolean;
}

interface SendWaiter {
  resolve: () => void;
  promise: Promise<void>;
}

/**
 * Folds a Claude Agent SDK frame stream into A2A task events.
 *
 * Turn boundaries are not message boundaries: sends may coalesce, so one
 * A2A Task is derived per turn *result*, bound to the send whose uuid the
 * turn's first reply frame echoes, and the folded sends are recorded on
 * the terminal status event.
 */
export class TurnTranslator {
  private readonly publish: (event: AgentExecutionEvent) => void;
  private readonly now: () => string;
  private readonly onWarning: (message: string) => void;

  private pending: PendingSend[] = [];
  private readonly onTurnResult: ((record: TurnAccounting) => void) | undefined;
  /**
   * Running totals as of the last result, per subprocess generation.
   * total_cost_usd and usage are cumulative within a generation (observed
   * and documented by the SDK); per-turn numbers are deltas against this.
   */
  private cumulative = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  private seqCounter = 0;
  private readonly seqOf = new Map<string, number>();
  private turn: OpenTurn | null = null;
  private caps: string[] | undefined;
  private readonly waiters = new Map<string, SendWaiter>();
  /** Task ids whose cancellation was requested via interrupt. */
  private readonly cancelRequested = new Set<string>();
  private ended = false;

  constructor(options: TranslatorOptions) {
    this.publish = options.publish;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onWarning = options.onWarning ?? (() => {});
    this.onTurnResult = options.onTurnResult;
  }

  /** Capabilities advertised on the last system/init frame, if any. */
  get capabilities(): string[] | undefined {
    return this.caps;
  }

  /** The task id of the currently open turn, if a turn is open. */
  get openTaskId(): string | undefined {
    return this.turn?.send.taskId;
  }

  registerSend(send: PendingSend): Promise<void> {
    if (this.ended) {
      throw new Error("stream already ended");
    }
    this.pending.push(send);
    this.seqOf.set(send.uuid, ++this.seqCounter);
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.waiters.set(send.uuid, { resolve, promise });
    return promise;
  }

  /** Marks a task as cancel-requested so its result maps to canceled. */
  markCancelRequested(taskId: string): void {
    this.cancelRequested.add(taskId);
    if (this.turn && this.turn.send.taskId === taskId) {
      this.turn.interrupted = true;
    }
  }

  /**
   * Records that a terminal event for this task was published outside the
   * translator (cancelTask does this), so the turn's eventual result frame
   * does not emit a second terminal.
   */
  markTerminalEmitted(taskId: string): void {
    if (this.turn !== null && this.turn.send.taskId === taskId) {
      this.turn.terminalEmitted = true;
    }
  }

  handleFrame(frame: SDKMessage): void {
    switch (frame.type) {
      case "system":
        if (frame.subtype === "init") {
          this.caps = frame.capabilities;
          // A new subprocess generation: its running cost/usage totals
          // start over, so the delta baseline must too.
          this.cumulative = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
        }
        return;
      case "stream_event":
        this.handleStreamEvent(frame);
        return;
      case "assistant":
        this.handleAssistant(frame);
        return;
      case "user":
        this.handleUser(frame);
        return;
      case "result":
        this.handleResult(frame);
        return;
      default:
        // The SDKMessage union is an open set; anything else is not a
        // turn-shaping signal for A2A translation.
        return;
    }
  }

  /**
   * The frame stream ended. A turn without a result — crashed subprocess,
   * closed pipe — must fail loudly, never stay in `working`; sends that
   * never got a turn fail too.
   */
  endStream(reason = "session stream ended without a result"): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    // The open turn's send is usually still in `pending` (only a result
    // removes it); track it so the loop below does not journal it twice.
    let recordedUuid: string | undefined;
    if (this.turn !== null && !this.turn.terminalEmitted) {
      this.closeOpenActivities(this.turn, "failed");
      this.flushText(this.turn, true);
      this.emitStatus(this.turn.send, TaskState.TASK_STATE_FAILED, {
        message: this.agentMessage(this.turn.send, reason),
        metadata: {},
      });
      this.turn.terminalEmitted = true;
      this.safeRecord(this.deadTurnRecord(this.turn.send, [...this.turn.toolNames], reason));
      recordedUuid = this.turn.send.uuid;
      this.resolveWaiter(this.turn.send.uuid);
      this.turn = null;
    }
    for (const send of this.pending) {
      this.publish(
        AgentEvent.task(this.taskShell(send, TaskState.TASK_STATE_FAILED, this.agentMessage(send, reason))),
      );
      // A send that never got a turn still journals: a routine that dies
      // before producing anything must not be invisible.
      if (send.uuid !== recordedUuid) {
        this.safeRecord(this.deadTurnRecord(send, [], reason));
      }
      this.resolveWaiter(send.uuid);
    }
    this.pending = [];
  }

  private handleStreamEvent(frame: SDKPartialAssistantMessage): void {
    if (frame.parent_tool_use_id !== null) {
      return; // subagent traffic
    }
    if (this.turn === null && frame.user_message_uuid !== undefined) {
      this.openTurn(frame.user_message_uuid);
    }
    const event = frame.event as { type?: string; delta?: { type?: string; text?: string } };
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      if (this.turn === null) {
        this.openTurn(undefined);
      }
      if (this.turn !== null && typeof event.delta.text === "string") {
        this.turn.sawStreamText = true;
        this.pushText(this.turn, event.delta.text);
      }
    }
  }

  private handleAssistant(frame: SDKAssistantMessage): void {
    if (frame.parent_tool_use_id !== null) {
      return; // subagent traffic
    }
    if (this.turn === null) {
      this.openTurn(frame.user_message_uuid);
    }
    if (this.turn === null) {
      return;
    }
    const turn = this.turn;
    if (frame.aborted === true) {
      turn.interrupted = true;
    }
    const content = frame.message.content;
    if (!Array.isArray(content)) {
      return;
    }
    for (const block of content) {
      const record = asRecord(block);
      if (record === undefined) {
        continue;
      }
      if (record.type === "tool_use") {
        this.openActivity(turn, record);
      } else if (
        record.type === "text" &&
        typeof record.text === "string" &&
        // Streamed deltas already carried this text.
        !turn.sawStreamText
      ) {
        this.pushText(turn, record.text);
      }
    }
  }

  /**
   * The CLI answers its own tool_use blocks with user-role tool_result
   * frames; they are what closes a tool card.
   */
  private handleUser(frame: Extract<SDKMessage, { type: "user" }>): void {
    if (frame.parent_tool_use_id !== null) {
      return; // subagent traffic
    }
    const turn = this.turn;
    if (turn === null) {
      return; // a tool result never opens a turn
    }
    const content = frame.message.content;
    if (!Array.isArray(content)) {
      return;
    }
    for (const block of content) {
      const record = asRecord(block);
      if (record === undefined || record.type !== "tool_result") {
        continue;
      }
      const id = record.tool_use_id;
      if (typeof id !== "string") {
        continue;
      }
      const open = turn.openTools.get(id);
      if (open === undefined) {
        continue; // not a card this turn opened
      }
      turn.openTools.delete(id);
      this.flushText(turn, false);
      this.emitActivity(turn, activity(id, record.is_error === true ? "failed" : "done", open));
    }
  }

  private openActivity(turn: OpenTurn, block: Record<string, unknown>): void {
    const { id, name } = block;
    if (typeof id !== "string" || typeof name !== "string" || turn.openTools.has(id)) {
      return;
    }
    const described = describeToolUse(name, block.input);
    const card = activity(id, "running", described);
    // The closing update redraws the card, so it carries the icon again.
    turn.openTools.set(id, { title: card.title, ...(card.icon === undefined ? {} : { icon: card.icon }) });
    turn.toolNames.add(name);
    // Text already buffered belongs ahead of the card it precedes.
    this.flushText(turn, false);
    this.emitActivity(turn, card);
  }

  /** Settle cards whose tool_result never arrived (interrupt, crash). */
  private closeOpenActivities(turn: OpenTurn, status: AgentActivityStatus): void {
    for (const [id, open] of turn.openTools) {
      this.emitActivity(turn, activity(id, status, open));
    }
    turn.openTools.clear();
  }

  private emitActivity(turn: OpenTurn, card: AgentActivity): void {
    this.publish(
      AgentEvent.artifactUpdate({
        taskId: turn.send.taskId,
        contextId: turn.send.contextId,
        artifact: {
          artifactId: ACTIVITY_ARTIFACT_ID,
          name: "agent-activity",
          description: "",
          parts: [
            {
              content: { $case: "data", value: card },
              mediaType: ACTIVITY_MEDIA_TYPE,
              filename: "",
              metadata: {},
            },
          ],
          metadata: {},
          extensions: [],
        },
        append: turn.activityEmitted > 0,
        // The activity stream has no natural end: the turn's terminal
        // status is what tells a consumer no more cards are coming.
        lastChunk: false,
        metadata: {},
      }),
    );
    turn.activityEmitted += 1;
  }

  private handleResult(frame: SDKResultMessage): void {
    if (this.turn === null) {
      // A turn can produce no reply frames at all; the result still
      // carries the join key.
      this.openTurn(frame.user_message_uuid);
    }
    const turn = this.turn;
    if (turn === null) {
      this.onWarning(`result frame ${frame.uuid} matched no pending send; dropped`);
      return;
    }

    const queued = frame.queued_turn_count ?? 0;
    const folded = this.takeFolded(turn.send, queued);
    const { state, message } = this.terminalStateFor(frame, turn);
    this.recordAccounting(frame, turn, state, queued);
    this.closeOpenActivities(turn, state === TaskState.TASK_STATE_COMPLETED ? "done" : "failed");
    this.flushText(turn, true);

    if (!turn.terminalEmitted) {
      const metadata: Record<string, unknown> = {
        [META_QUEUED_TURN_COUNT]: queued,
        [META_FOLDED_MESSAGE_IDS]: folded.map((send) => send.messageId),
        ...this.questionMetadata(frame),
      };
      this.emitStatus(turn.send, state, { message, metadata });
      turn.terminalEmitted = true;
    }
    for (const send of folded) {
      if (send.uuid !== turn.send.uuid) {
        // A folded send's own A2A call still needs a well-formed response:
        // acknowledge with a completed task pointing at the task that
        // carries the answer, instead of leaving its caller to the
        // server's executor-published-nothing failure path.
        this.publish(
          AgentEvent.task({
            ...this.taskShell(send, TaskState.TASK_STATE_COMPLETED),
            metadata: { [META_FOLDED_INTO]: turn.send.taskId },
          }),
        );
      }
      this.resolveWaiter(send.uuid);
    }
    this.cancelRequested.delete(turn.send.taskId);
    this.turn = null;
  }

  /**
   * The options behind an agent's question, so a client can offer them as
   * something to tap. Only AskUserQuestion carries a shape worth rendering;
   * any other deferred tool stays prose.
   */
  private questionMetadata(frame: SDKResultMessage): Record<string, unknown> {
    if (frame.subtype !== "success" || frame.deferred_tool_use === undefined) {
      return {};
    }
    const { name, input } = frame.deferred_tool_use;
    const questions = name === "AskUserQuestion" ? parseAgentQuestions(input) : undefined;
    return questions === undefined ? {} : { [META_QUESTIONS]: questions };
  }

  private recordAccounting(
    frame: SDKResultMessage,
    turn: OpenTurn,
    state: TaskState,
    queued: number,
  ): void {
    if (this.onTurnResult === undefined) {
      return;
    }
    // A generation restart resets the running totals; a total below the
    // baseline means this frame counts from zero again.
    const deltaOf = (current: number, previous: number): number =>
      current >= previous ? current - previous : current;
    const usage = frame.usage as Partial<{
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    }>;
    const current = {
      cost: frame.total_cost_usd ?? 0,
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheCreation: usage.cache_creation_input_tokens ?? 0,
    };
    const record: TurnAccounting = {
      taskId: turn.send.taskId,
      contextId: turn.send.contextId,
      trigger: this.triggerOf(turn.send),
      state: stateName(state),
      durationMs: frame.duration_ms,
      durationApiMs: frame.duration_api_ms,
      costUsd: deltaOf(current.cost, this.cumulative.cost),
      inputTokens: deltaOf(current.input, this.cumulative.input),
      outputTokens: deltaOf(current.output, this.cumulative.output),
      cacheReadTokens: deltaOf(current.cacheRead, this.cumulative.cacheRead),
      cacheCreationTokens: deltaOf(current.cacheCreation, this.cumulative.cacheCreation),
      toolsUsed: [...turn.toolNames],
      permissionDenials: (frame.permission_denials ?? []).map((denial) => denial.tool_name),
      ...(this.errorOf(frame, state) === undefined ? {} : { error: this.errorOf(frame, state) }),
      queuedTurnCount: queued,
    };
    this.cumulative = current;
    this.safeRecord(record);
  }

  private errorOf(frame: SDKResultMessage, state: TaskState): string | undefined {
    if (state === TaskState.TASK_STATE_CANCELED) {
      return "turn interrupted";
    }
    if (state !== TaskState.TASK_STATE_FAILED) {
      return undefined;
    }
    if (frame.subtype === "success") {
      return frame.result;
    }
    return frame.errors.length > 0 ? frame.errors.join("; ") : frame.subtype;
  }

  private triggerOf(send: PendingSend): string {
    const raw = send.message?.metadata?.[META_TRIGGER];
    return typeof raw === "string" && raw !== "" ? raw : "human";
  }

  /** Accounting for a turn that never saw a result frame: all zeros, failed. */
  private deadTurnRecord(send: PendingSend, toolsUsed: string[], reason: string): TurnAccounting {
    return {
      taskId: send.taskId,
      contextId: send.contextId,
      trigger: this.triggerOf(send),
      state: "failed",
      durationMs: 0,
      durationApiMs: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolsUsed,
      permissionDenials: [],
      error: reason,
      queuedTurnCount: 0,
    };
  }

  /** A journal sink must never be able to fail a turn. */
  private safeRecord(record: TurnAccounting): void {
    try {
      this.onTurnResult?.(record);
    } catch (err) {
      this.onWarning(`turn accounting sink failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private terminalStateFor(
    frame: SDKResultMessage,
    turn: OpenTurn,
  ): { state: TaskState; message: Message | undefined } {
    if (turn.interrupted || this.cancelRequested.has(turn.send.taskId)) {
      return {
        state: TaskState.TASK_STATE_CANCELED,
        message: this.agentMessage(turn.send, "turn interrupted"),
      };
    }
    if (frame.subtype === "success") {
      if (frame.is_error) {
        return {
          state: TaskState.TASK_STATE_FAILED,
          message: this.agentMessage(turn.send, frame.result),
        };
      }
      if (frame.deferred_tool_use !== undefined) {
        // The agent asked and stopped: interrupted state, not terminal.
        return {
          state: TaskState.TASK_STATE_INPUT_REQUIRED,
          message: this.agentMessage(turn.send, frame.result),
        };
      }
      return {
        state: TaskState.TASK_STATE_COMPLETED,
        message: this.agentMessage(turn.send, frame.result),
      };
    }
    const detail = frame.errors.length > 0 ? frame.errors.join("; ") : frame.subtype;
    return {
      state: TaskState.TASK_STATE_FAILED,
      message: this.agentMessage(turn.send, detail),
    };
  }

  /**
   * Which sends this turn consumed. queued_turn_count is a snapshot of the
   * CLI's queue at result time, but a send can be in flight — written to
   * stdin, not yet enqueued — and invisible to it (observed live: a rapid
   * second DM was mis-folded and its whole turn dropped). Two guards make
   * the inference sound: only sends registered before the turn opened are
   * fold-eligible (the CLI folds at dequeue time), and the queue census is
   * first discounted by the ineligible sends it necessarily includes.
   * The primary is always included.
   */
  private takeFolded(primary: PendingSend, queuedTurnCount: number): PendingSend[] {
    const openSeq = this.turn?.openSeq ?? this.seqCounter;
    const rest = this.pending.filter((send) => send.uuid !== primary.uuid);
    const eligible = rest.filter((send) => (this.seqOf.get(send.uuid) ?? Infinity) <= openSeq);
    const ineligibleCount = rest.length - eligible.length;
    const queuedEligible = Math.max(0, queuedTurnCount - ineligibleCount);
    const foldedExtra = Math.max(0, eligible.length - queuedEligible);
    const foldedSet = new Set(eligible.slice(0, foldedExtra).map((send) => send.uuid));
    this.pending = rest.filter((send) => !foldedSet.has(send.uuid));
    return [primary, ...eligible.slice(0, foldedExtra)];
  }

  private openTurn(userMessageUuid: string | undefined): void {
    let send: PendingSend | undefined;
    if (userMessageUuid !== undefined) {
      send = this.pending.find((candidate) => candidate.uuid === userMessageUuid);
      if (send === undefined) {
        this.onWarning(
          `turn bound to unknown user_message_uuid ${userMessageUuid}; ignoring frames until a known turn starts`,
        );
        return;
      }
    } else {
      // Older producers omit the stamp entirely; fall back to FIFO order.
      send = this.pending[0];
      if (send === undefined) {
        return; // unsolicited turn (scheduled/meta); nothing to translate
      }
    }
    this.turn = {
      send,
      openSeq: this.seqCounter,
      emittedText: "",
      pendingChunk: null,
      chunksEmitted: 0,
      sawStreamText: false,
      openTools: new Map(),
      toolNames: new Set(),
      activityEmitted: 0,
      interrupted: this.cancelRequested.has(send.taskId),
      terminalEmitted: false,
    };
    this.publish(AgentEvent.task(this.taskShell(send, TaskState.TASK_STATE_WORKING)));
  }

  /**
   * Chunk emission holds one chunk back so the final chunk can carry
   * lastChunk: true without a trailing empty frame; concatenating emitted
   * chunks reproduces the assistant text exactly.
   */
  private pushText(turn: OpenTurn, text: string): void {
    if (text === "") {
      return;
    }
    if (turn.pendingChunk !== null) {
      this.emitChunk(turn, turn.pendingChunk, false);
    }
    turn.pendingChunk = text;
  }

  private flushText(turn: OpenTurn, last: boolean): void {
    if (turn.pendingChunk !== null) {
      this.emitChunk(turn, turn.pendingChunk, last);
      turn.pendingChunk = null;
    }
  }

  private emitChunk(turn: OpenTurn, text: string, lastChunk: boolean): void {
    const artifact: Artifact = {
      artifactId: ASSISTANT_TEXT_ARTIFACT_ID,
      name: "assistant-text",
      description: "",
      parts: [
        {
          content: { $case: "text", value: text },
          mediaType: "text/plain",
          filename: "",
          metadata: {},
        },
      ],
      metadata: {},
      extensions: [],
    };
    this.publish(
      AgentEvent.artifactUpdate({
        taskId: turn.send.taskId,
        contextId: turn.send.contextId,
        artifact,
        append: turn.chunksEmitted > 0,
        lastChunk,
        metadata: {},
      }),
    );
    turn.chunksEmitted += 1;
    turn.emittedText += text;
  }

  private emitStatus(
    send: PendingSend,
    state: TaskState,
    extra: { message: Message | undefined; metadata: Record<string, unknown> },
  ): void {
    this.publish(
      AgentEvent.statusUpdate({
        taskId: send.taskId,
        contextId: send.contextId,
        status: this.status(state, extra.message),
        metadata: extra.metadata,
      }),
    );
  }

  private status(state: TaskState, message?: Message): TaskStatus {
    return { state, message, timestamp: this.now() };
  }

  private taskShell(send: PendingSend, state: TaskState, message?: Message) {
    return {
      id: send.taskId,
      contextId: send.contextId,
      status: this.status(state, message),
      artifacts: [],
      history: send.message !== undefined ? [send.message] : [],
      metadata: {},
    };
  }

  private agentMessage(send: PendingSend, text: string): Message {
    return {
      messageId: `${send.taskId}-status-${this.now()}`,
      contextId: send.contextId,
      taskId: send.taskId,
      role: Role.ROLE_AGENT,
      parts: [
        {
          content: { $case: "text", value: text },
          mediaType: "text/plain",
          filename: "",
          metadata: {},
        },
      ],
      metadata: {},
      extensions: [],
      referenceTaskIds: [],
    };
  }

  private resolveWaiter(uuid: string): void {
    this.waiters.get(uuid)?.resolve();
    this.waiters.delete(uuid);
    this.seqOf.delete(uuid);
  }
}
