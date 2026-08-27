import { TaskState } from "@a2a-js/sdk";
import type { Message, Task } from "@a2a-js/sdk";
import { deriveSessionId } from "@thicket/executor";

import type { BridgeState } from "./state.js";
import {
  META_QUEUED_TURN_COUNT,
  META_SHOULD_QUERY,
  type A2AEvent,
  type AgentClient,
  type InboundEvent,
  type SlackApi,
  type SlackSessionStatus,
} from "./types.js";

export interface EngineLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface EngineOptions {
  agent: string;
  queueing: "harness" | "bridge";
  client: AgentClient;
  slack: SlackApi;
  state: BridgeState;
  logger?: EngineLogger;
}

const TERMINAL = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

/** Slack caps session titles at 200 characters. */
const TITLE_MAX = 200;

/** A thread's session name, taken from the message that opened it. */
export function sessionTitle(text: string): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") {
    return undefined;
  }
  return flat.length <= TITLE_MAX ? flat : `${flat.slice(0, TITLE_MAX - 1)}…`;
}

function textPart(text: string) {
  return {
    content: { $case: "text" as const, value: text },
    mediaType: "text/plain",
    filename: "",
    metadata: {},
  };
}

export function slackStatusFor(state: TaskState): SlackSessionStatus {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED:
    case TaskState.TASK_STATE_WORKING:
      return "processing";
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return "suspended";
    default:
      // completed, input-required, failed, rejected, canceled: the thread
      // is ready for the user again.
      return "active";
  }
}

/**
 * Per-agent policy machine translating Slack's agent surface to A2A.
 * Transport-free: Socket Mode envelopes are unwrapped before they get
 * here, and every side effect goes through the injected client/slack/
 * state, so the whole contract is testable against stubs.
 */
export class BridgeEngine {
  private readonly agent: string;
  private readonly queueing: "harness" | "bridge";
  private readonly client: AgentClient;
  private readonly slack: SlackApi;
  private readonly state: BridgeState;
  private readonly logger: EngineLogger;
  /** Per-thread promise chains for queueing: bridge. */
  private readonly chains = new Map<string, Promise<void>>();
  /** Streams currently open per thread; release waits for the last one. */
  private readonly turnsOpen = new Map<string, number>();
  /** Deferred session-status release, applied when turnsOpen drains to 0. */
  private readonly pendingRelease = new Map<string, SlackSessionStatus>();
  /** Tasks whose activity cards were abandoned after a Slack rejection. */
  private readonly activityOff = new Set<string>();
  /** Threads whose prose status line was abandoned after a rejection. */
  private readonly noteOff = new Set<string>();
  constructor(options: EngineOptions) {
    this.agent = options.agent;
    this.queueing = options.queueing;
    this.client = options.client;
    this.slack = options.slack;
    this.state = options.state;
    this.logger = options.logger ?? { info: () => {}, warn: () => {} };
  }

  /** Reattach to tasks recorded by a previous bridge process. */
  async start(): Promise<void> {
    for (const task of this.state.allTasks()) {
      if (task.agent !== this.agent) {
        continue;
      }
      void this.pumpTracked(
        this.client.resubscribe(task.taskId),
        task.channel,
        task.threadTs,
        undefined,
      ).catch((err: unknown) => {
        this.logger.warn("resubscribe failed", { taskId: task.taskId, err: String(err) });
      });
    }
  }

  async handleEvent(event: InboundEvent): Promise<void> {
    switch (event.kind) {
      case "session_stopped": {
        for (const task of this.state.tasksForThread(event.channel, event.threadTs)) {
          this.logger.info("stop button: canceling", { taskId: task.taskId });
          await this.client.cancel(task.taskId);
        }
        return;
      }
      case "dm":
      case "mention":
        await this.trigger(event.channel, event.threadTs, event.text, event.messageTs);
        return;
      case "thread_message": {
        if (!this.state.isEngaged(event.channel, event.threadTs)) {
          return; // not our conversation
        }
        // Context for the agent, no turn: delivered with shouldQuery:false
        // semantics via metadata; no status change, no reply expected.
        await this.client.send(
          this.buildMessage(event.channel, event.threadTs, event.text, event.messageTs, false),
        );
        return;
      }
    }
  }

  /** Queue-or-run per the roster's queueing policy. */
  private trigger(
    channel: string,
    threadTs: string,
    text: string,
    messageTs: string,
  ): Promise<void> {
    if (this.queueing === "harness") {
      // The harness queues concurrent turns itself; send without waiting.
      return this.runTurn(channel, threadTs, text, messageTs);
    }
    const key = `${channel}:${threadTs}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(
      () => this.runTurn(channel, threadTs, text, messageTs),
      () => this.runTurn(channel, threadTs, text, messageTs),
    );
    this.chains.set(key, next);
    return next;
  }

  private async runTurn(
    channel: string,
    threadTs: string,
    text: string,
    messageTs: string,
  ): Promise<void> {
    const contextId = this.contextIdFor(channel, threadTs);
    // Slack takes a session title only when the session is created, so the
    // thread's first message is the only chance to name it.
    const opening = !this.state.isEngaged(channel, threadTs);
    this.state.saveContext(channel, threadTs, contextId);
    await this.slack.setStatus(
      channel,
      threadTs,
      "processing",
      opening ? { title: sessionTitle(text) } : undefined,
    );
    // Something to read during the seconds before the first tool call.
    await this.note(channel, threadTs, "is thinking…");

    let card: { streaming: boolean };
    try {
      card = await this.client.fetchCard();
    } catch (err) {
      await this.unreachable(channel, threadTs, text, messageTs, err);
      return;
    }

    const message = this.buildMessage(channel, threadTs, text, messageTs, true);
    try {
      if (card.streaming) {
        await this.pumpTracked(this.client.stream(message), channel, threadTs, contextId);
      } else {
        const task = await this.client.send(message);
        await this.finishBlocking(task, channel, threadTs, contextId);
      }
    } catch (err) {
      this.logger.warn("turn failed", { channel, threadTs, err: String(err) });
      await this.slack.postMessage(
        channel,
        threadTs,
        `Something went wrong talking to ${this.agent}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.slack.setStatus(channel, threadTs, "active");
    }
  }

  private async unreachable(
    channel: string,
    threadTs: string,
    text: string,
    messageTs: string,
    err: unknown,
  ): Promise<void> {
    this.logger.warn("agent unreachable; queueing", { agent: this.agent, err: String(err) });
    this.state.enqueue({ agent: this.agent, channel, threadTs, text, messageTs });
    await this.slack.postMessage(
      channel,
      threadTs,
      `${this.agent} is unreachable right now (its machine may be asleep). ` +
        `Your message is queued and will be delivered when it comes back.`,
    );
    await this.slack.setStatus(channel, threadTs, "active");
  }

  /**
   * Deliver queued requests once the agent's card is fetchable again.
   * Returns the number delivered; 0 when still unreachable or empty.
   */
  async flushQueue(): Promise<number> {
    const queued = this.state.queuedFor(this.agent);
    if (queued.length === 0) {
      return 0;
    }
    try {
      await this.client.fetchCard();
    } catch {
      return 0;
    }
    let delivered = 0;
    for (const request of queued) {
      this.state.dequeue(request.id);
      delivered += 1;
      await this.trigger(request.channel, request.threadTs, request.text, request.messageTs);
    }
    return delivered;
  }

  private contextIdFor(channel: string, threadTs: string): string {
    // Derivation is the fast path; an agent-minted contextId recorded from
    // an earlier turn wins from then on.
    return this.state.contextFor(channel, threadTs) ?? deriveSessionId(channel, threadTs);
  }

  private buildMessage(
    channel: string,
    threadTs: string,
    text: string,
    messageTs: string,
    shouldQuery: boolean,
  ): Message {
    return {
      messageId: `slack-${channel}-${messageTs}`,
      contextId: this.contextIdFor(channel, threadTs),
      taskId: "",
      role: 1,
      parts: [textPart(text)],
      metadata: shouldQuery ? {} : { [META_SHOULD_QUERY]: false },
      extensions: [],
      referenceTaskIds: [],
    };
  }

  /**
   * Wraps pump with per-thread accounting. Concurrent per-send streams
   * deliver events in no global order, so a stale terminal from a slow
   * stream could overwrite the final session status; instead, terminal
   * releases are deferred until the thread's last open stream drains.
   */
  private async pumpTracked(
    events: AsyncIterable<A2AEvent>,
    channel: string,
    threadTs: string,
    sentContextId: string | undefined,
  ): Promise<void> {
    const key = `${channel}:${threadTs}`;
    this.turnsOpen.set(key, (this.turnsOpen.get(key) ?? 0) + 1);
    try {
      await this.pump(events, channel, threadTs, sentContextId);
    } finally {
      const left = (this.turnsOpen.get(key) ?? 1) - 1;
      this.turnsOpen.set(key, left);
      if (left === 0) {
        const release = this.pendingRelease.get(key);
        if (release !== undefined) {
          this.pendingRelease.delete(key);
          await this.slack.setStatus(channel, threadTs, release);
        }
      }
    }
  }

  /** Consumes a task event stream, driving Slack as events arrive. */
  private async pump(
    events: AsyncIterable<A2AEvent>,
    channel: string,
    threadTs: string,
    sentContextId: string | undefined,
  ): Promise<void> {
    for await (const event of events) {
      await this.handleA2AEvent(event, channel, threadTs, sentContextId);
    }
  }

  private async handleA2AEvent(
    event: A2AEvent,
    channel: string,
    threadTs: string,
    sentContextId: string | undefined,
  ): Promise<void> {
    switch (event.kind) {
      case "task": {
        this.state.recordTask({
          taskId: event.task.id,
          agent: this.agent,
          channel,
          threadTs,
          streamTs: null,
        });
        if (sentContextId !== undefined && event.task.contextId !== sentContextId) {
          // The agent minted its own contextId; persist and use it from
          // now on (A2A lets the agent win).
          this.logger.info("agent minted contextId", {
            proposed: sentContextId,
            minted: event.task.contextId,
          });
          this.state.saveContext(channel, threadTs, event.task.contextId);
        }
        const state = event.task.status?.state;
        if (state !== undefined) {
          await this.applyStatus(event.task.id, state, channel, threadTs, undefined, undefined);
        }
        return;
      }
      case "artifact": {
        const streamTs = await this.ensureStream(event.taskId, channel, threadTs);
        await this.slack.appendStream(channel, streamTs, event.text);
        if (event.lastChunk) {
          await this.slack.stopStream(channel, streamTs);
          this.state.setStreamTs(event.taskId, null);
        }
        return;
      }
      case "activity": {
        // Progress display is never worth a failed turn: if Slack rejects a
        // card, drop cards for the rest of this task and keep going.
        if (this.activityOff.has(event.taskId)) {
          return;
        }
        try {
          const streamTs = await this.ensureStream(event.taskId, channel, threadTs);
          for (const activity of event.activities) {
            await this.slack.appendActivity(channel, streamTs, activity);
            if (activity.status === "running") {
              // The card timeline is the record; the status line is the
              // glance. Only the opening of a step is worth announcing.
              await this.note(channel, threadTs, `${activity.title}…`);
            }
          }
        } catch (err) {
          this.activityOff.add(event.taskId);
          this.logger.warn("activity cards abandoned for this task", {
            taskId: event.taskId,
            err: String(err),
          });
        }
        return;
      }
      case "status": {
        await this.applyStatus(
          event.taskId,
          event.state,
          channel,
          threadTs,
          event.messageText,
          event.metadata,
        );
        return;
      }
    }
  }

  /**
   * The prose status line. Purely informational, so a rejection retires it
   * for the thread rather than costing the answer.
   */
  private async note(channel: string, threadTs: string, status: string): Promise<void> {
    const key = `${channel}:${threadTs}`;
    if (this.noteOff.has(key)) {
      return;
    }
    try {
      await this.slack.setThreadStatus(channel, threadTs, status);
    } catch (err) {
      this.noteOff.add(key);
      this.logger.warn("thread status abandoned", { channel, threadTs, err: String(err) });
    }
  }

  /** The task's Slack stream, opened on first use. */
  private async ensureStream(taskId: string, channel: string, threadTs: string): Promise<string> {
    const record = this.state.taskById(taskId);
    if (record?.streamTs != null) {
      return record.streamTs;
    }
    const streamTs = await this.slack.startStream(channel, threadTs);
    if (record === undefined) {
      this.state.recordTask({ taskId, agent: this.agent, channel, threadTs, streamTs });
    } else {
      this.state.setStreamTs(taskId, streamTs);
    }
    return streamTs;
  }

  /**
   * A turn whose last act is a tool call never emits a final text chunk, so
   * the terminal state — not lastChunk — is what guarantees the stream is
   * closed.
   */
  private async closeStream(taskId: string, channel: string): Promise<void> {
    const streamTs = this.state.taskById(taskId)?.streamTs;
    if (streamTs == null) {
      return;
    }
    this.state.setStreamTs(taskId, null);
    await this.slack.stopStream(channel, streamTs);
  }

  private async applyStatus(
    taskId: string,
    state: TaskState,
    channel: string,
    threadTs: string,
    messageText: string | undefined,
    metadata: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (state === TaskState.TASK_STATE_AUTH_REQUIRED) {
      await this.slack.postMessage(
        channel,
        threadTs,
        messageText ??
          `${this.agent} needs authentication before it can continue. Check its configuration.`,
      );
      await this.slack.setStatus(channel, threadTs, "suspended");
      return;
    }

    if (
      state === TaskState.TASK_STATE_FAILED ||
      state === TaskState.TASK_STATE_REJECTED
    ) {
      await this.slack.postMessage(
        channel,
        threadTs,
        messageText ?? `${this.agent} could not complete this request.`,
      );
    }

    const key = `${channel}:${threadTs}`;
    if (TERMINAL.has(state)) {
      await this.closeStream(taskId, channel);
      // A turn that ends without posting anything — a cancel — would
      // otherwise leave its last step on screen until Slack's timeout.
      await this.note(channel, threadTs, "");
      this.activityOff.delete(taskId);
      this.state.removeTask(taskId);
      const queuedTurns = Number(metadata?.[META_QUEUED_TURN_COUNT] ?? 0);
      if (queuedTurns > 0) {
        // More turns follow without further input: the session is already
        // processing and their streams are still open, so stay held and
        // let a later terminal set the release.
        return;
      }
      if ((this.turnsOpen.get(key) ?? 0) > 0) {
        // Defer: another stream for this thread is still open, and event
        // order across streams is not global — a stale terminal must not
        // overwrite the final state.
        this.pendingRelease.set(key, slackStatusFor(state));
        return;
      }
    }
    await this.slack.setStatus(channel, threadTs, slackStatusFor(state));
  }

  /** Non-streaming agents: one message with the final text. */
  private async finishBlocking(
    task: Task,
    channel: string,
    threadTs: string,
    sentContextId: string,
  ): Promise<void> {
    if (task.contextId !== sentContextId) {
      this.state.saveContext(channel, threadTs, task.contextId);
    }
    const state = task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
    const statusMessage = task.status?.message?.parts
      .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
      .join("");
    const artifactText = task.artifacts
      .flatMap((artifact) => artifact.parts)
      .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
      .join("");
    const finalText = statusMessage !== undefined && statusMessage !== "" ? statusMessage : artifactText;
    if (
      state === TaskState.TASK_STATE_COMPLETED ||
      state === TaskState.TASK_STATE_INPUT_REQUIRED
    ) {
      await this.slack.postMessage(channel, threadTs, finalText);
    }
    await this.applyStatus(
      task.id,
      state,
      channel,
      threadTs,
      finalText === "" ? undefined : finalText,
      undefined,
    );
  }
}
