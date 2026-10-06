import { TaskState } from "@a2a-js/sdk";
import type { Message } from "@a2a-js/sdk";
import {
  deriveSessionId,
  linksIn,
  META_DISCORD_CHANNEL,
  META_DISCORD_THREAD,
  META_ENVELOPE,
  META_QUEUED_TURN_COUNT,
  META_SHOULD_QUERY,
  META_WORKSPACE,
  type ReferencedAttachment,
  type Envelope,
  type Participant,
  type Reference,
} from "@thicket/executor";

import { CALLBACK, THREAD_TYPES, CHANNEL_TYPE, type CardBody, type DiscordApi } from "./api.js";
import {
  carriedSteps,
  renderCard,
  STOP_ID,
  SUPPRESS_NOTIFICATIONS,
  terminalStatus,
  textBudget,
  type CardState,
  type CardView,
} from "./card.js";
import { threadName } from "./discord-api.js";
import { CardEditor } from "./editor.js";
import { reopen, splitMarkdown, START, takeChunk, type Cursor } from "./markdown.js";
import type { BridgeState, CardStep } from "./state.js";
import type {
  A2AEvent,
  AgentActivity,
  AgentClient,
  ComponentEvent,
  DiscordAttachment,
  EngineLogger,
  InboundEvent,
  MessageEvent,
} from "./types.js";

/**
 * `uuidv5("discord:" + channel)`, or with an epoch for a DM the operator
 * started over, through the same derivation Slack threads use, so a context
 * id is computed from coordinates rather than stored.
 */
export function deriveContextId(channel: string, epoch?: string): string {
  return deriveSessionId("discord", epoch === undefined ? channel : `${channel}:${epoch}`);
}

/** Message types that are conversation. https://docs.discord.com/developers/resources/message */
const MESSAGE_TYPES = new Set([0, 19]);

/** Plain content caps at 2,000 characters; the fallback splits at it. */
const PLAIN_LIMIT = 2_000;

/** The typing indicator lasts ten seconds; this keeps it lit through a turn. */
const TYPING_INTERVAL_MS = 8_000;

/** How much history a replayed turn carries. */
const REPLAY_LIMIT = 50;

const THINKING = "Thinking…";

/**
 * Discord's client sends a forward and the comment typed with it as two
 * messages, and the gap between them was observed at four seconds. They
 * are one intent, so a forward-only message waits this long for its
 * comment before it is a turn of its own; a lone forward pays the pause.
 */
const FORWARD_HOLD_MS = 6_000;

const TERMINAL = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

export interface EngineOptions {
  agent: string;
  /** The one server the bridge serves; messages from any other are ignored. */
  guildId: string;
  /** Discord user ids who may give agents work. Nobody else's message is a turn. */
  operators: string[];
  /** Bot user ids admitted as operators; only ever set by the live-test harness. */
  testBots?: string[];
  /** The bot's own user id, once the Gateway has said READY. */
  selfId: () => string | undefined;
  queueing: "harness" | "bridge";
  context?: "native" | "replay";
  client: AgentClient;
  discord: DiscordApi;
  state: BridgeState;
  logger?: EngineLogger;
  /** Base URL agents reach this bridge on, for attachments; absent declines them. */
  fileBaseUrl?: string;
  /** Channel id → workspace name, from the roster. */
  bindings?: Record<string, string>;
  /** The editor's flush interval, for tests. */
  editIntervalMs?: number;
  /** How long a forward-only message waits for the comment the client sends after it. */
  forwardHoldMs?: number;
  /** Test override for the per-card text budget. */
  textLimit?: number;
}

/** A card as the engine is drawing it, before and between flushes. */
interface Draft {
  channel: string;
  messageId: string | null;
  status: string;
  steps: CardStep[];
  text: string;
  cursor: Cursor;
  /** The message that triggered the turn, when it is in the same channel: the reply target. */
  replyTo: string | null;
  /** A person spoke beneath this card; the next content opens a new one. */
  stale: boolean;
  /** A rollover page: posted silently, so a long answer does not buzz once per page. */
  silent: boolean;
  /** The card can no longer be edited; text is buffered for a plain post. */
  abandoned: boolean;
  buffered: string;
}

/**
 * Per-agent policy machine translating Discord's surface to A2A: the turn
 * table, the turn card, and the failure table. Transport-free: Gateway
 * frames are translated before they get here, and every side effect goes
 * through the injected client, api and state, so the whole contract is
 * testable against stubs.
 */
export class BridgeEngine {
  private readonly agent: string;
  private readonly guildId: string;
  private readonly operators: Set<string>;
  private readonly testBots: Set<string>;
  private readonly selfId: () => string | undefined;
  private readonly queueing: "harness" | "bridge";
  private readonly context: "native" | "replay";
  private readonly client: AgentClient;
  private readonly discord: DiscordApi;
  private readonly state: BridgeState;
  private readonly logger: EngineLogger;
  private readonly fileBaseUrl: string | undefined;
  private readonly bindings: Record<string, string>;
  private readonly editor: CardEditor;
  private readonly textLimit: number | undefined;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly drafts = new Map<string, Draft>();
  /** Open turns per channel, for the typing indicator. */
  private readonly turnsOpen = new Map<string, number>();
  private readonly typing = new Map<string, NodeJS.Timeout>();
  private readonly forwardHoldMs: number;
  /** Forward-only messages waiting for their comment, keyed by channel and author. */
  private readonly heldForwards = new Map<string, { event: MessageEvent; timer: NodeJS.Timeout; release: () => void }>();

  constructor(options: EngineOptions) {
    this.agent = options.agent;
    this.guildId = options.guildId;
    this.operators = new Set(options.operators);
    this.testBots = new Set(options.testBots ?? []);
    this.selfId = options.selfId;
    this.queueing = options.queueing;
    this.context = options.context ?? "native";
    this.client = options.client;
    this.discord = options.discord;
    this.state = options.state;
    this.logger = options.logger ?? { info: () => {}, warn: () => {} };
    this.fileBaseUrl = options.fileBaseUrl?.replace(/\/+$/, "");
    this.bindings = options.bindings ?? {};
    this.textLimit = options.textLimit;
    this.forwardHoldMs = options.forwardHoldMs ?? FORWARD_HOLD_MS;
    this.editor = new CardEditor({
      flush: (channel, messageId, body) => this.flushCard(channel, messageId, body as CardBody),
      ...(options.editIntervalMs === undefined ? {} : { intervalMs: options.editIntervalMs }),
    });
  }

  /** Reattach to tasks recorded by a previous bridge process. */
  async start(): Promise<void> {
    for (const task of this.state.allTasks()) {
      if (task.agent !== this.agent) {
        continue;
      }
      if (task.card !== null) {
        this.drafts.set(task.taskId, {
          channel: task.channel,
          messageId: task.card.messageId,
          status: task.card.status,
          steps: task.card.steps,
          text: task.card.text,
          cursor: START,
          replyTo: task.triggerId ?? null,
          stale: false,
          silent: false,
          abandoned: false,
          buffered: "",
        });
      }
      void this.pumpTracked(this.client.resubscribe(task.taskId), task.channel, undefined, undefined, undefined).catch(
        (err: unknown) => {
          this.logger.warn("resubscribe failed", { taskId: task.taskId, err: String(err) });
        },
      );
    }
  }

  async handleEvent(event: InboundEvent): Promise<void> {
    switch (event.kind) {
      case "message":
        await this.handleMessage(event);
        return;
      case "component":
        await this.handleComponent(event);
        return;
      case "modal":
      case "command":
        // M2: questions as forms, and /new.
        await this.discord.respondEphemeral(event.interactionId, event.token, "Not available yet.");
        return;
    }
  }

  // ------------------------------------------------------------ the turn table

  private async handleMessage(event: MessageEvent): Promise<void> {
    if (event.guild !== undefined && event.guild !== this.guildId) {
      return;
    }
    if (!MESSAGE_TYPES.has(event.type)) {
      return;
    }
    if (event.authorIsApp && !this.testBots.has(event.authorId)) {
      return;
    }
    if (!this.operators.has(event.authorId) && !this.testBots.has(event.authorId)) {
      this.logger.info("ignoring a message from someone who is not an operator", {
        channel: event.channel,
        author: event.authorId,
      });
      return;
    }
    if (!this.state.markHandled(this.agent, event.messageId)) {
      this.logger.info("dropping a redelivered message", { messageId: event.messageId });
      return;
    }
    const merged = await this.mergeForward(event);
    if (merged === undefined) {
      return; // held, waiting for its comment
    }
    event = merged;
    const self = this.selfId();
    const mentioned = self !== undefined && event.mentions.includes(self);

    if (event.guild === undefined) {
      await this.trigger(event.channel, event, event.messageId);
      return;
    }

    let info;
    try {
      info = await this.discord.channelInfo(event.channel);
    } catch (err) {
      this.logger.warn("channel lookup failed; message ignored", { channel: event.channel, err: String(err) });
      return;
    }
    if (!THREAD_TYPES.has(info.type)) {
      if (!mentioned) {
        return;
      }
      await this.openThread(event);
      return;
    }

    const parent = info.parentId ?? null;
    const context = this.state.contextFor(this.agent, event.channel);
    const forumBound = parent !== null && this.bindings[parent] !== undefined && (await this.isForum(parent));
    if (context === undefined && forumBound) {
      this.state.saveContext(this.agent, event.channel, {
        contextId: deriveContextId(event.channel),
        answerer: true,
        parent,
      });
      await this.trigger(event.channel, event, event.messageId);
      return;
    }
    if (mentioned) {
      if (context === undefined) {
        this.state.saveContext(this.agent, event.channel, {
          contextId: deriveContextId(event.channel),
          answerer: false,
          parent,
        });
      }
      await this.trigger(event.channel, event, event.messageId);
      return;
    }
    if (context === undefined) {
      return;
    }
    const otherAgentMentioned = event.botMentions.some((id) => id !== self);
    if (context.answerer && !otherAgentMentioned) {
      await this.trigger(event.channel, event, event.messageId);
      return;
    }
    await this.sendContext(event.channel, event);
  }

  /**
   * A forward-only message is held for the comment the client sends right
   * after it; the comment, when it comes from the same author in the same
   * channel within the window, absorbs the forward and becomes the turn.
   * Returns the event to classify, or nothing while one is held.
   */
  private mergeForward(event: MessageEvent): Promise<MessageEvent | undefined> {
    const key = `${event.channel}:${event.authorId}`;
    const held = this.heldForwards.get(key);
    if (held !== undefined) {
      this.heldForwards.delete(key);
      clearTimeout(held.timer);
      held.release();
      return Promise.resolve({
        ...event,
        forwards: [...held.event.forwards, ...event.forwards],
        files: [...held.event.files, ...event.files],
      });
    }
    if (event.text.trim() !== "" || event.forwards.length === 0) {
      return Promise.resolve(event);
    }
    return new Promise<MessageEvent | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.heldForwards.delete(key);
        resolve(event);
      }, this.forwardHoldMs);
      timer.unref?.();
      this.heldForwards.set(key, { event, timer, release: () => resolve(undefined) });
    });
  }

  private async isForum(channelId: string): Promise<boolean> {
    try {
      const info = await this.discord.channelInfo(channelId);
      return info.type === CHANNEL_TYPE.GUILD_FORUM || info.type === CHANNEL_TYPE.GUILD_MEDIA;
    } catch {
      return false;
    }
  }

  /** A mention in a guild channel: the conversation gets a thread of its own. */
  private async openThread(event: MessageEvent): Promise<void> {
    let threadId: string;
    try {
      threadId = await this.discord.createThread(event.channel, event.messageId, threadName(event.text));
    } catch (err) {
      this.logger.warn("thread creation refused; turn refused", { channel: event.channel, err: String(err) });
      await this.say(event.channel, `I can't open a thread here (${errorText(err)}), so I won't answer in the channel.`, {
        replyTo: event.messageId,
        ping: true,
      });
      return;
    }
    this.state.saveContext(this.agent, threadId, {
      contextId: deriveContextId(threadId),
      answerer: true,
      parent: event.channel,
    });
    // The card is the thread's first message; the trigger is in the parent,
    // where a reply reference cannot reach.
    await this.trigger(threadId, event, null);
  }

  /** Context for the agent, no turn: delivered with shouldQuery:false. */
  private async sendContext(channel: string, event: MessageEvent): Promise<void> {
    this.markStale(channel);
    const files = this.acceptFiles(channel, event);
    const bound = await this.workspaceFor(channel);
    if ("error" in bound) {
      this.logger.warn("context message dropped: workspace unresolved", { channel, err: bound.error });
      return;
    }
    try {
      await this.client.send(await this.buildMessage(channel, event.text, event.messageId, false, files, bound.workspace, event));
    } catch (err) {
      this.logger.warn("context message not delivered", { channel, err: String(err) });
    }
  }

  // ----------------------------------------------------------------- the turn

  /** Queue-or-run per the roster's queueing policy. */
  private trigger(channel: string, event: MessageEvent, replyTo: string | null): Promise<void> {
    this.markStale(channel);
    const run = () => this.runTurn(channel, event.text, event.messageId, this.acceptFiles(channel, event), event.authorId, replyTo, event);
    if (this.queueing === "harness") {
      return run();
    }
    const prev = this.chains.get(channel) ?? Promise.resolve();
    const next = prev.then(run, run);
    this.chains.set(channel, next);
    return next;
  }

  private async runTurn(
    channel: string,
    text: string,
    messageId: string,
    fileIds: string[],
    authorId: string,
    replyTo: string | null,
    event?: MessageEvent,
  ): Promise<void> {
    const contextId = this.contextIdFor(channel);
    const bound = await this.workspaceFor(channel);
    if ("error" in bound) {
      this.logger.warn("turn refused: workspace unresolved", { channel, err: bound.error });
      await this.say(
        channel,
        `I can't tell which channel this is (${bound.error}), so I won't guess which workspace to work in. Try again in a moment.`,
        { replyTo: replyTo ?? undefined, ping: true },
      );
      return;
    }
    let card: { streaming: boolean };
    try {
      card = await this.client.fetchCard();
    } catch (err) {
      await this.unreachable(channel, text, messageId, fileIds, authorId, replyTo, err);
      return;
    }
    const outgoing = await this.withReplayContext(channel, text, messageId);
    const message = await this.buildMessage(channel, outgoing, messageId, true, fileIds, bound.workspace, event);
    this.startTyping(channel);
    try {
      if (card.streaming) {
        await this.pumpTracked(this.client.stream(message), channel, contextId, replyTo, authorId);
      } else {
        const task = await this.client.send(message);
        if (task.contextId !== contextId) {
          this.saveMintedContext(channel, task.contextId);
        }
        const finalText = task.artifacts
          .flatMap((artifact) => artifact.parts)
          .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
          .join("");
        if (finalText !== "") {
          await this.sayLong(channel, finalText, replyTo);
        }
        const state = task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
        await this.applyStatus(task.id, state, channel, replyTo, undefined, undefined);
      }
    } catch (err) {
      this.logger.warn("turn failed", { channel, err: String(err) });
      await this.say(channel, `Something went wrong talking to ${this.agent}: ${errorText(err)}`, {
        replyTo: replyTo ?? undefined,
        ping: true,
      });
      this.stopTyping(channel);
    }
  }

  private async unreachable(
    channel: string,
    text: string,
    messageId: string,
    fileIds: string[],
    authorId: string,
    replyTo: string | null,
    err: unknown,
  ): Promise<void> {
    this.logger.warn("agent unreachable; queueing", { agent: this.agent, err: String(err) });
    this.state.enqueue({ agent: this.agent, channel, text, messageId, fileIds, authorId });
    await this.say(
      channel,
      `${this.agent} is unreachable right now (its machine may be asleep). Your message is queued and will be delivered when it comes back.`,
      { replyTo: replyTo ?? undefined, ping: true },
    );
  }

  /** Deliver queued requests once the agent's card is fetchable again. */
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
      await this.runTurn(request.channel, request.text, request.messageId, request.fileIds, request.authorId ?? "", request.messageId);
    }
    return delivered;
  }

  private async withReplayContext(channel: string, text: string, messageId: string): Promise<string> {
    if (this.context !== "replay") {
      return text;
    }
    try {
      const history = await this.discord.readMessages(channel, REPLAY_LIMIT);
      const transcript = history
        .filter((m) => m.id !== messageId && m.text !== "")
        .map((m) => `[${m.authorIsApp ? "agent" : m.authorId}] ${m.text}`);
      if (transcript.length === 0) {
        return text;
      }
      return (
        "Thread so far, replayed because you keep no conversation state:\n" +
        transcript.join("\n") +
        `\n\nCurrent message:\n${text}`
      );
    } catch (err) {
      this.logger.warn("replay transcript unavailable; sending bare message", { channel, err: String(err) });
      return text;
    }
  }

  private contextIdFor(channel: string): string {
    return this.state.contextFor(this.agent, channel)?.contextId ?? deriveContextId(channel);
  }

  private saveMintedContext(channel: string, contextId: string): void {
    const row = this.state.contextFor(this.agent, channel);
    this.logger.info("agent minted contextId", { channel, minted: contextId });
    this.state.saveContext(this.agent, channel, {
      contextId,
      answerer: row?.answerer ?? true,
      parent: row?.parent ?? null,
    });
  }

  /**
   * The workspace a channel is bound to. A DM is never bound. A thread is
   * bound through its parent; while the parent is unknown the answer is an
   * error, not "unbound".
   */
  private async workspaceFor(channel: string): Promise<{ workspace?: string } | { error: string }> {
    if (Object.keys(this.bindings).length === 0) {
      return {};
    }
    const row = this.state.contextFor(this.agent, channel);
    let parent = row?.parent ?? null;
    if (parent === null) {
      try {
        const info = await this.discord.channelInfo(channel);
        if (info.type === CHANNEL_TYPE.DM) {
          return {};
        }
        parent = info.parentId ?? channel;
      } catch (err) {
        return { error: `channel lookup failed: ${errorText(err)}` };
      }
    }
    const direct = this.bindings[channel] ?? this.bindings[parent];
    return direct === undefined ? {} : { workspace: direct };
  }

  /** Record uploads so the agent can fetch them through the bridge. */
  private acceptFiles(channel: string, event: MessageEvent): string[] {
    if (event.files.length === 0) {
      return [];
    }
    if (this.fileBaseUrl === undefined) {
      this.logger.warn("attachment declined: no reachable bridge address", { agent: this.agent, count: event.files.length });
      return [];
    }
    for (const file of event.files) {
      this.state.recordFile({
        fileId: file.id,
        agent: this.agent,
        channel,
        messageId: event.messageId,
        name: file.name,
        contentType: file.contentType,
        size: file.size,
        url: file.url,
      });
    }
    return event.files.map((file) => file.id);
  }

  /**
   * The agent's own mention, as it reads to the agent: its name. The id
   * means nothing from inside the session, and a model that sees it guesses.
   * Other people's mentions keep their ids, which the toolbelt needs.
   */
  private readable(text: string): string {
    const self = this.selfId();
    return self === undefined ? text : text.replaceAll(new RegExp(`<@!?${self}>`, "g"), `@${this.agent}`);
  }

  /** The envelope: where, who, and what the message points at, in the shared shape. */
  private envelope(channel: string, messageId: string, event: MessageEvent | undefined): Envelope {
    const row = this.state.contextFor(this.agent, channel);
    const self = this.selfId();
    const kind = event?.guild === undefined ? "DM" : row?.parent !== null && row?.parent !== undefined ? "thread" : "channel";
    const participant = (id: string, name: string | undefined, isApp: boolean): Participant => ({
      id,
      ...(name === undefined ? {} : { name }),
      kind: id === self || isApp ? "agent" : this.operators.has(id) ? "operator" : "person",
      ...(id === self ? { self: true } : {}),
    });
    const attachments = (files: { name: string; contentType: string; size: number; url: string }[]): ReferencedAttachment[] =>
      files.map((f) => ({ name: f.name, mediaType: f.contentType, size: f.size, url: f.url }));
    const references: Reference[] = [];
    if (event?.replyTo !== undefined) {
      const author = event.reply?.author;
      references.push({
        kind: "reply",
        message: event.replyTo,
        ...(author === undefined ? {} : { author: participant(author.id, author.name, author.isApp) }),
        ...(event.reply?.text === undefined || event.reply.text === "" ? {} : { text: event.reply.text }),
        ...(event.reply === undefined || event.reply.files.length === 0 ? {} : { attachments: attachments(event.reply.files) }),
      });
    }
    for (const forward of event?.forwards ?? []) {
      references.push({
        kind: "forward",
        text: forward.text,
        ...(forward.files.length === 0 ? {} : { attachments: attachments(forward.files) }),
      });
    }
    for (const url of linksIn(event?.text ?? "")) {
      references.push({ kind: "link", url });
    }
    const mentions = (event?.mentions ?? []).map((id) =>
      participant(id, event?.mentionNames[id], event?.botMentions.includes(id) ?? false),
    );
    return {
      surface: "discord",
      place: {
        kind,
        channel: row?.parent ?? channel,
        ...(kind === "thread" ? { thread: channel } : {}),
        message: messageId,
      },
      ...(event === undefined ? {} : { author: participant(event.authorId, event.authorName, event.authorIsApp) }),
      ...(mentions.length === 0 ? {} : { mentions }),
      ...(references.length === 0 ? {} : { references }),
    };
  }

  private async buildMessage(
    channel: string,
    text: string,
    messageId: string,
    shouldQuery: boolean,
    fileIds: string[],
    workspace?: string,
    event?: MessageEvent,
  ): Promise<Message> {
    // A forward arrives as an empty message carrying snapshots. The agent
    // reads the message's own words, so an empty one with forwards gets the
    // forwarded text as its body; the envelope still says it was forwarded.
    if (text.trim() === "" && event !== undefined && event.forwards.length > 0) {
      text = event.forwards.map((f) => `(forwarded) ${f.text}`).join("\n\n");
    }
    text = this.readable(text);
    const row = this.state.contextFor(this.agent, channel);
    const files = fileIds.map((id) => this.state.fileFor(this.agent, id)).filter((f) => f !== undefined);
    return {
      messageId: `discord-${channel}-${messageId}`,
      contextId: this.contextIdFor(channel),
      taskId: "",
      role: 1,
      parts: [
        { content: { $case: "text" as const, value: text }, mediaType: "text/plain", filename: "", metadata: {} },
        ...files.map((file) => filePart(`${this.fileBaseUrl}/files/${encodeURIComponent(file.fileId)}`, file)),
      ],
      metadata: {
        [META_DISCORD_CHANNEL]: row?.parent ?? channel,
        [META_DISCORD_THREAD]: channel,
        [META_ENVELOPE]: this.envelope(channel, messageId, event),
        ...(workspace === undefined ? {} : { [META_WORKSPACE]: workspace }),
        ...(shouldQuery ? {} : { [META_SHOULD_QUERY]: false }),
      },
      extensions: [],
      referenceTaskIds: [],
    };
  }

  // ---------------------------------------------------------------- the pump

  private async pumpTracked(
    events: AsyncIterable<A2AEvent>,
    channel: string,
    sentContextId: string | undefined,
    replyTo: string | null | undefined,
    authorId: string | undefined,
  ): Promise<void> {
    this.turnsOpen.set(channel, (this.turnsOpen.get(channel) ?? 0) + 1);
    try {
      for await (const event of events) {
        await this.handleA2AEvent(event, channel, sentContextId, replyTo ?? null, authorId);
      }
    } finally {
      const left = (this.turnsOpen.get(channel) ?? 1) - 1;
      this.turnsOpen.set(channel, left);
      if (left === 0) {
        this.stopTyping(channel);
      }
    }
  }

  private async handleA2AEvent(
    event: A2AEvent,
    channel: string,
    sentContextId: string | undefined,
    replyTo: string | null,
    authorId: string | undefined,
  ): Promise<void> {
    switch (event.kind) {
      case "task": {
        if (this.state.taskById(event.task.id) === undefined) {
          this.state.recordTask({
            taskId: event.task.id,
            agent: this.agent,
            channel,
            triggerId: replyTo,
            authorId: authorId ?? null,
            card: null,
          });
        }
        if (sentContextId !== undefined && event.task.contextId !== sentContextId) {
          this.saveMintedContext(channel, event.task.contextId);
        }
        const state = event.task.status?.state;
        if (state === TaskState.TASK_STATE_WORKING || state === TaskState.TASK_STATE_SUBMITTED) {
          // The card exists from the first moment of the turn: the status
          // line says the agent is thinking, and Stop is there to press
          // before any text arrives.
          const draft = this.draft(event.task.id, channel, replyTo);
          if (draft.messageId === null && !draft.abandoned) {
            await this.draw(event.task.id, draft, "working");
          }
          return;
        }
        if (state !== undefined) {
          await this.applyStatus(event.task.id, state, channel, replyTo, undefined, undefined);
        }
        return;
      }
      case "artifact":
        await this.appendText(event.taskId, channel, replyTo, event.text);
        return;
      case "activity":
        for (const activity of event.activities) {
          await this.applyActivity(event.taskId, channel, replyTo, activity);
        }
        return;
      case "status":
        await this.applyStatus(event.taskId, event.state, channel, replyTo, event.messageText, event.metadata);
        return;
    }
  }

  // ---------------------------------------------------------------- the card

  private draft(taskId: string, channel: string, replyTo: string | null): Draft {
    let draft = this.drafts.get(taskId);
    if (draft === undefined) {
      draft = {
        channel,
        messageId: null,
        status: THINKING,
        steps: [],
        text: "",
        cursor: START,
        replyTo,
        stale: false,
        silent: false,
        abandoned: false,
        buffered: "",
      };
      this.drafts.set(taskId, draft);
    }
    return draft;
  }

  private view(draft: Draft, state: CardState): CardView {
    return { state, status: draft.status, steps: draft.steps, text: draft.text };
  }

  /**
   * The card never quotes the message it answers: it follows that message,
   * and a reply reference to the line above is noise. The states that need
   * the operator back are posted as pinged replies by applyStatus instead.
   */
  private body(draft: Draft, state: CardState): CardBody {
    const rendered = renderCard(this.view(draft, state));
    return {
      ...rendered,
      flags: draft.silent ? rendered.flags | SUPPRESS_NOTIFICATIONS : rendered.flags,
    };
  }

  private limit(): number {
    return this.textLimit ?? Number.POSITIVE_INFINITY;
  }

  private budget(draft: Draft): number {
    const full = textBudget(draft.status, draft.steps);
    return Math.min(full, this.limit());
  }

  /** Append streamed text to the task's card, rolling over when it would not fit. */
  private async appendText(taskId: string, channel: string, replyTo: string | null, text: string): Promise<void> {
    const draft = this.draft(taskId, channel, replyTo);
    if (draft.abandoned) {
      draft.buffered += text;
      return;
    }
    await this.cutIfStale(taskId, draft);
    let rest = text;
    while (rest !== "") {
      const prefix = draft.text === "" ? reopen(draft.cursor) : "";
      const room = this.budget(draft) - draft.text.length - prefix.length;
      if (draft.text !== "" && room < 1) {
        await this.rollOver(taskId, draft);
        continue;
      }
      const chunk = takeChunk(rest, Math.max(room, 1), draft.cursor);
      draft.text += prefix + chunk.head;
      draft.cursor = chunk.cursor;
      rest = chunk.rest;
      await this.draw(taskId, draft, "working");
      if (rest !== "") {
        await this.rollOver(taskId, draft);
      }
    }
  }

  private async applyActivity(taskId: string, channel: string, replyTo: string | null, activity: AgentActivity): Promise<void> {
    const draft = this.draft(taskId, channel, replyTo);
    if (draft.abandoned) {
      return;
    }
    await this.cutIfStale(taskId, draft);
    const step: CardStep = { id: activity.id, title: activity.title, status: activity.status };
    const at = draft.steps.findIndex((s) => s.id === activity.id);
    if (at >= 0) {
      draft.steps[at] = step;
    } else {
      draft.steps.push(step);
    }
    const running = draft.steps.filter((s) => s.status === "running").at(-1);
    draft.status = running === undefined ? THINKING : `${running.title}…`;
    if (draft.text !== "" && draft.text.length > this.budget(draft)) {
      await this.rollOver(taskId, draft);
      return;
    }
    await this.draw(taskId, draft, "working");
  }

  /** Post the card if it has none, else schedule an edit with the latest body. */
  private async draw(taskId: string, draft: Draft, state: CardState): Promise<void> {
    if (draft.messageId === null) {
      try {
        draft.messageId = await this.discord.postCard(draft.channel, this.body(draft, state));
      } catch (err) {
        this.logger.warn("card could not be posted; answer will be delivered plain", { taskId, err: String(err) });
        this.abandon(taskId, draft);
        return;
      }
      this.persist(taskId, draft);
      return;
    }
    this.editor.schedule(draft.channel, draft.messageId, { taskId, body: this.body(draft, state) });
  }

  /** The editor's flush: one edit, and the record of what the card now shows. */
  private async flushCard(channel: string, messageId: string, body: CardBody): Promise<void> {
    const { taskId, body: card } = body as unknown as { taskId: string; body: CardBody };
    try {
      await this.discord.editCard(channel, messageId, card);
      const draft = this.drafts.get(taskId);
      if (draft !== undefined && draft.messageId === messageId) {
        this.persist(taskId, draft);
      }
    } catch (err) {
      this.logger.warn("card edit refused; answer will be delivered plain", { taskId, messageId, err: String(err) });
      const draft = this.drafts.get(taskId);
      if (draft !== undefined) {
        this.abandon(taskId, draft);
      }
    }
  }

  private persist(taskId: string, draft: Draft): void {
    if (draft.messageId === null) {
      return;
    }
    this.state.setCard(taskId, { messageId: draft.messageId, status: draft.status, steps: draft.steps, text: draft.text });
  }

  /** The card is lost to us; everything from here is buffered for a plain post. */
  private abandon(taskId: string, draft: Draft): void {
    if (draft.messageId !== null) {
      this.editor.forget(draft.channel, draft.messageId);
    }
    draft.abandoned = true;
    draft.buffered = draft.text + draft.buffered;
    draft.text = "";
    draft.messageId = null;
    this.state.setCard(taskId, null);
  }

  /** Freeze the current card and open the next one below with the steps carried. */
  private async rollOver(taskId: string, draft: Draft): Promise<void> {
    await this.freeze(draft, taskId);
    draft.messageId = null;
    draft.text = "";
    draft.steps = carriedSteps(draft.steps);
    draft.replyTo = null;
    draft.stale = false;
    draft.silent = true;
    if (draft.cursor.fence !== undefined) {
      draft.cursor = { fence: draft.cursor.fence, partial: "" };
    }
  }

  /** One final edit on a card nothing more will go into. */
  private async freeze(draft: Draft, taskId: string): Promise<void> {
    if (draft.messageId === null) {
      return;
    }
    const closing = draft.cursor.fence === undefined ? "" : `\n${draft.cursor.fence.marker}`;
    const frozen: Draft = { ...draft, text: draft.text + closing };
    await this.editor.settle(draft.channel, draft.messageId, { taskId, body: this.body(frozen, "frozen") });
  }

  /**
   * A person spoke beneath an open card, so whatever the agent says next
   * belongs below them: the open cards in the channel are marked, and the
   * next content cuts to a new card.
   */
  private markStale(channel: string): void {
    for (const [, draft] of this.drafts) {
      if (draft.channel === channel && draft.messageId !== null) {
        draft.stale = true;
      }
    }
  }

  private async cutIfStale(taskId: string, draft: Draft): Promise<void> {
    if (!draft.stale) {
      return;
    }
    await this.rollOver(taskId, draft);
  }

  // -------------------------------------------------------------- the status

  private async applyStatus(
    taskId: string,
    state: TaskState,
    channel: string,
    replyTo: string | null,
    messageText: string | undefined,
    metadata: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (state === TaskState.TASK_STATE_AUTH_REQUIRED) {
      await this.say(channel, messageText ?? `${this.agent} needs authentication before it can continue.`, {
        replyTo: replyTo ?? undefined,
        ping: true,
      });
      return;
    }
    if (state === TaskState.TASK_STATE_INPUT_REQUIRED) {
      // M2 renders the question card; the prose question already reached
      // the card, and a typed reply answers it.
      const draft = this.drafts.get(taskId);
      if (draft !== undefined) {
        draft.status = terminalStatus("waiting");
        await this.settleCard(taskId, draft, "waiting");
      }
      await this.say(channel, messageText ?? `${this.agent} is waiting for your answer.`, {
        replyTo: replyTo ?? undefined,
        ping: true,
      });
      return;
    }
    if (!TERMINAL.has(state)) {
      return;
    }
    const cardState: CardState =
      state === TaskState.TASK_STATE_COMPLETED
        ? "completed"
        : state === TaskState.TASK_STATE_CANCELED
          ? "cancelled"
          : "failed";
    const draft = this.drafts.get(taskId);
    if (draft !== undefined) {
      draft.status = terminalStatus(cardState);
      draft.steps = draft.steps.map((s) => (s.status === "running" ? { ...s, status: cardState === "completed" ? "done" : "failed" } : s));
      await this.settleCard(taskId, draft, cardState);
      if (draft.buffered.trim() !== "") {
        await this.sayLong(channel, draft.buffered, replyTo);
      }
      this.drafts.delete(taskId);
    }
    if (state === TaskState.TASK_STATE_FAILED || state === TaskState.TASK_STATE_REJECTED) {
      await this.say(channel, messageText ?? `${this.agent} could not complete this request.`, {
        replyTo: replyTo ?? undefined,
        ping: true,
      });
    }
    this.state.removeTask(taskId);
    const queuedTurns = Number(metadata?.[META_QUEUED_TURN_COUNT] ?? 0);
    if (queuedTurns === 0 && (this.turnsOpen.get(channel) ?? 0) <= 1) {
      this.stopTyping(channel);
    }
  }

  /** The card's last edit, waited for: the final state must not sit behind a frame. */
  private async settleCard(taskId: string, draft: Draft, state: CardState): Promise<void> {
    if (draft.abandoned) {
      return;
    }
    if (draft.messageId === null) {
      await this.draw(taskId, draft, state);
      return;
    }
    const closing = draft.cursor.fence === undefined ? "" : `\n${draft.cursor.fence.marker}`;
    const final: Draft = { ...draft, text: draft.text + closing };
    await this.editor.settle(draft.channel, draft.messageId, { taskId, body: this.body(final, state) });
  }

  // ---------------------------------------------------------- interactions

  private async handleComponent(event: ComponentEvent): Promise<void> {
    if (!this.operators.has(event.userId) && !this.testBots.has(event.userId)) {
      await this.discord.respondEphemeral(event.interactionId, event.token, "This agent only takes instructions from its operator.");
      return;
    }
    if (event.customId !== STOP_ID) {
      return; // a question card's element: M2
    }
    const tasks = this.state.tasksForChannel(this.agent, event.channel).filter((t) => t.card?.messageId === event.messageId);
    if (tasks.length === 0) {
      await this.discord.respondEphemeral(event.interactionId, event.token, "That turn has already finished.");
      return;
    }
    await this.discord.respond(event.interactionId, event.token, CALLBACK.DEFERRED_UPDATE);
    for (const task of tasks) {
      this.logger.info("stop button: canceling", { taskId: task.taskId });
      try {
        await this.client.cancel(task.taskId);
      } catch (err) {
        this.logger.warn("cancel failed", { taskId: task.taskId, err: String(err) });
      }
    }
  }

  // --------------------------------------------------------------- plumbing

  private async say(channel: string, text: string, options: { replyTo?: string; ping?: boolean } = {}): Promise<void> {
    try {
      await this.discord.postMessage(channel, {
        text: text.length <= PLAIN_LIMIT ? text : `${text.slice(0, PLAIN_LIMIT - 1)}…`,
        ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
        ping: options.ping ?? false,
      });
    } catch (err) {
      this.logger.warn("message could not be posted", { channel, err: String(err) });
    }
  }

  /** Answer text that could not ride a card: plain messages, split by the markdown splitter. */
  private async sayLong(channel: string, text: string, replyTo: string | null): Promise<void> {
    const pieces = splitMarkdown(text, PLAIN_LIMIT);
    for (const [i, piece] of pieces.entries()) {
      await this.say(channel, piece, i === 0 && replyTo !== null ? { replyTo } : {});
    }
  }

  private startTyping(channel: string): void {
    if (this.typing.has(channel)) {
      return;
    }
    const tick = () => {
      this.discord.typing(channel).catch((err: unknown) => {
        this.logger.warn("typing indicator refused", { channel, err: String(err) });
      });
    };
    tick();
    const timer = setInterval(tick, TYPING_INTERVAL_MS);
    timer.unref?.();
    this.typing.set(channel, timer);
  }

  private stopTyping(channel: string): void {
    const timer = this.typing.get(channel);
    if (timer !== undefined) {
      clearInterval(timer);
      this.typing.delete(channel);
    }
  }
}

function filePart(url: string, file: { name: string; contentType: string; size: number }) {
  return {
    content: { $case: "url" as const, value: url },
    mediaType: file.contentType,
    filename: file.name,
    metadata: { "thicket.fileSize": file.size },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { META_DISCORD_CHANNEL, META_DISCORD_THREAD };
export type { DiscordAttachment };
