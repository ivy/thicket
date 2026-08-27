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
  type SlackFile,
  type SlackSessionStatus,
} from "./types.js";

export interface EngineLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface EngineOptions {
  agent: string;
  queueing: "harness" | "bridge";
  /**
   * Roster context policy: `native` trusts the harness to keep
   * conversation state by contextId; `replay` assumes a stateless harness
   * and re-sends the thread's transcript with every turn.
   */
  context?: "native" | "replay";
  client: AgentClient;
  slack: SlackApi;
  state: BridgeState;
  logger?: EngineLogger;
  /**
   * Base URL agents can reach this bridge on, e.g.
   * https://thicket-bridge.tail1234.ts.net. Attachments are referred to
   * beneath it; without one there is nowhere to point, so they are
   * declined in-thread rather than linked into the void.
   */
  fileBaseUrl?: string;
}

/**
 * How much thread a replayed turn carries. Enough for a conversation, a
 * hard stop before a long channel thread eats the whole turn.
 */
const REPLAY_LIMIT = 50;

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

/** Metadata key carrying an attachment's byte count alongside its url part. */
export const META_FILE_SIZE = "thicket.fileSize";

function filePart(url: string, file: SlackFile) {
  return {
    content: { $case: "url" as const, value: url },
    mediaType: file.mimetype,
    filename: file.name,
    metadata: { [META_FILE_SIZE]: file.size },
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
  private readonly context: "native" | "replay";
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
  private readonly fileBaseUrl: string | undefined;
  constructor(options: EngineOptions) {
    this.agent = options.agent;
    this.queueing = options.queueing;
    this.context = options.context ?? "native";
    this.client = options.client;
    this.slack = options.slack;
    this.state = options.state;
    this.logger = options.logger ?? { info: () => {}, warn: () => {} };
    this.fileBaseUrl = options.fileBaseUrl?.replace(/\/+$/, "");
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
    if (event.kind !== "session_stopped" && (await this.authoredByBot(event))) {
      return;
    }
    switch (event.kind) {
      case "session_stopped": {
        for (const task of this.state.tasksForThread(event.channel, event.threadTs)) {
          this.logger.info("stop button: canceling", { taskId: task.taskId });
          await this.client.cancel(task.taskId);
        }
        return;
      }
      case "dm":
      case "mention": {
        const files = await this.acceptFiles(event);
        await this.trigger(event.channel, event.threadTs, event.text, event.messageTs, files);
        return;
      }
      case "thread_message": {
        if (!this.state.isEngaged(event.channel, event.threadTs)) {
          return; // not our conversation
        }
        const files = await this.acceptFiles(event);
        if (this.context === "replay") {
          // A stateless harness gets the whole thread with its next turn;
          // pushing context between turns would state-keep on its behalf.
          // Files are still recorded above so a later turn can fetch them.
          return;
        }
        // Context for the agent, no turn: delivered with shouldQuery:false
        // semantics via metadata; no status change, no reply expected.
        await this.client.send(
          this.buildMessage(
            event.channel,
            event.threadTs,
            event.text,
            event.messageTs,
            false,
            files,
          ),
        );
        return;
      }
    }
  }

  /**
   * The loop guard. An agent answering its own posts is the failure this
   * prevents, and `bot_id` alone does not identify one: a human posting
   * through any app's user token gets the app's bot_id stamped on their
   * message, while an agent's own reply carries its bot user as the author.
   * So the author decides, and only a lookup can say — asked only when a
   * bot_id was present at all, and cached by the Slack layer.
   */
  private async authoredByBot(event: {
    authorId: string;
    viaApp: boolean;
  }): Promise<boolean> {
    if (!event.viaApp) {
      return false; // no app involved: a person typed it
    }
    try {
      const isBot = await this.slack.isBotUser(event.authorId);
      if (isBot) {
        this.logger.info("ignoring a bot-authored message", { author: event.authorId });
      }
      return isBot;
    } catch (err) {
      // Fail closed: an unanswered message beats an agent talking to itself.
      this.logger.warn("could not resolve message author; ignoring", {
        author: event.authorId,
        err: String(err),
      });
      return true;
    }
  }

  /**
   * Record uploads so the agent can fetch them, before anything else can
   * fail — a queued or retried turn refers to them by id afterwards.
   * Returns the ids that were accepted.
   */
  private async acceptFiles(event: {
    channel: string;
    threadTs: string;
    files: SlackFile[];
  }): Promise<string[]> {
    if (event.files.length === 0) {
      return [];
    }
    if (this.fileBaseUrl === undefined) {
      this.logger.warn("attachment declined: no reachable bridge address", {
        agent: this.agent,
        count: event.files.length,
      });
      await this.slack.postMessage(
        event.channel,
        event.threadTs,
        `I can't read attachments yet — ${this.agent} has no reachable address configured for file transfer. ` +
          `I'll answer what I can from your message.`,
      );
      return [];
    }
    for (const file of event.files) {
      this.state.recordFile({
        fileId: file.id,
        agent: this.agent,
        channel: event.channel,
        threadTs: event.threadTs,
        name: file.name,
        mimetype: file.mimetype,
        size: file.size,
        url: file.downloadUrl,
      });
    }
    return event.files.map((file) => file.id);
  }

  /** Queue-or-run per the roster's queueing policy. */
  private trigger(
    channel: string,
    threadTs: string,
    text: string,
    messageTs: string,
    fileIds: string[],
  ): Promise<void> {
    if (this.queueing === "harness") {
      // The harness queues concurrent turns itself; send without waiting.
      return this.runTurn(channel, threadTs, text, messageTs, fileIds);
    }
    const key = `${channel}:${threadTs}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(
      () => this.runTurn(channel, threadTs, text, messageTs, fileIds),
      () => this.runTurn(channel, threadTs, text, messageTs, fileIds),
    );
    this.chains.set(key, next);
    return next;
  }

  private async runTurn(
    channel: string,
    threadTs: string,
    text: string,
    messageTs: string,
    fileIds: string[],
  ): Promise<void> {
    const contextId = this.contextIdFor(channel, threadTs);
    // Slack takes a session title only when the session is created, so the
    // thread's first message is the only chance to name it.
    const opening = !this.state.isEngaged(channel, threadTs);
    this.state.saveContext(channel, threadTs, contextId);
    if (opening) {
      // The acknowledgement that costs nothing and is always correct:
      // eyes on the message that opened the session. Everything after
      // this is the agent's judgement, and a failed reaction is never
      // worth a failed turn.
      try {
        await this.slack.addReaction(channel, messageTs, "eyes");
      } catch (err) {
        this.logger.warn("opening reaction failed", { channel, messageTs, err: String(err) });
      }
    }
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
      await this.unreachable(channel, threadTs, text, messageTs, fileIds, err);
      return;
    }

    const outgoing = await this.withReplayContext(channel, threadTs, text, messageTs);
    const message = this.buildMessage(channel, threadTs, outgoing, messageTs, true, fileIds);
    try {
      if (card.streaming) {
        await this.pumpTracked(this.client.stream(message), channel, threadTs, contextId, messageTs);
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
    fileIds: string[],
    err: unknown,
  ): Promise<void> {
    this.logger.warn("agent unreachable; queueing", { agent: this.agent, err: String(err) });
    this.state.enqueue({ agent: this.agent, channel, threadTs, text, messageTs, fileIds });
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
      await this.trigger(
        request.channel,
        request.threadTs,
        request.text,
        request.messageTs,
        request.fileIds,
      );
    }
    return delivered;
  }

  /**
   * For a stateless harness, the turn's text carries the thread so far —
   * `context: replay` in the roster. The triggering message is excluded
   * from the transcript (it follows as the current message), and a fetch
   * failure degrades to the bare message: a turn without history beats no
   * turn.
   */
  private async withReplayContext(
    channel: string,
    threadTs: string,
    text: string,
    messageTs: string,
  ): Promise<string> {
    if (this.context !== "replay") {
      return text;
    }
    try {
      const messages = await this.slack.replies(channel, threadTs, REPLAY_LIMIT);
      const transcript = messages
        .filter((m) => m.ts !== messageTs && m.text !== "")
        .map((m) => `[${m.authorId ?? m.botId ?? "unknown"}] ${m.text}`);
      if (transcript.length === 0) {
        return text;
      }
      return (
        "Thread so far, replayed because you keep no conversation state:\n" +
        transcript.join("\n") +
        `\n\nCurrent message:\n${text}`
      );
    } catch (err) {
      this.logger.warn("replay transcript unavailable; sending bare message", {
        channel,
        threadTs,
        err: String(err),
      });
      return text;
    }
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
    fileIds: string[],
  ): Message {
    const files = fileIds
      .map((id) => this.state.fileFor(this.agent, id))
      .filter((file) => file !== undefined);
    return {
      messageId: `slack-${channel}-${messageTs}`,
      contextId: this.contextIdFor(channel, threadTs),
      taskId: "",
      role: 1,
      parts: [
        textPart(text),
        ...files.map((file) =>
          filePart(`${this.fileBaseUrl}/files/${encodeURIComponent(file.fileId)}`, {
            id: file.fileId,
            name: file.name,
            mimetype: file.mimetype,
            size: file.size,
            downloadUrl: "",
          }),
        ),
      ],
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
    messageTs?: string,
  ): Promise<void> {
    const key = `${channel}:${threadTs}`;
    this.turnsOpen.set(key, (this.turnsOpen.get(key) ?? 0) + 1);
    try {
      await this.pump(events, channel, threadTs, sentContextId, messageTs);
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
    messageTs?: string,
  ): Promise<void> {
    for await (const event of events) {
      await this.handleA2AEvent(event, channel, threadTs, sentContextId, messageTs);
    }
  }

  private async handleA2AEvent(
    event: A2AEvent,
    channel: string,
    threadTs: string,
    sentContextId: string | undefined,
    messageTs?: string,
  ): Promise<void> {
    switch (event.kind) {
      case "task": {
        this.state.recordTask({
          taskId: event.task.id,
          agent: this.agent,
          channel,
          threadTs,
          streamTs: null,
          // The triggering message: what a bare `react` tool call targets.
          messageTs: messageTs ?? null,
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
