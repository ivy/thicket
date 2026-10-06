import type { AgentActivity } from "@thicket/executor";

/**
 * An upload attached to a Slack message. `downloadUrl` is Slack-private:
 * it needs the bot token, so only the bridge can ever redeem it.
 */
export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  downloadUrl: string;
}

interface MessageEvent {
  channel: string;
  threadTs: string;
  text: string;
  messageTs: string;
  files: SlackFile[];
  /** Slack user id of the author. */
  authorId: string;
  /** Carried a bot_id: posted through an app, by a human or a bot. */
  viaApp: boolean;
}

/** One tapped or changed element in a block_actions payload. */
export interface BlockAction {
  actionId: string;
  blockId: string;
  /** A button's value. */
  value?: string;
  /** A radio group's or checkbox group's current selection values. */
  selected?: string[];
}

/** Slack events the bridge acts on, already unwrapped from envelopes. */
export type InboundEvent =
  | ({ kind: "dm" } & MessageEvent)
  | ({ kind: "mention" } & MessageEvent)
  | ({ kind: "thread_message" } & MessageEvent)
  | {
      kind: "session_stopped";
      channel: string;
      threadTs: string;
    }
  | {
      /** Someone interacted with a message the bridge posted. */
      kind: "block_action";
      channel: string;
      /** ts of the message carrying the tapped element. */
      messageTs: string;
      threadTs?: string;
      /** Slack user id of whoever tapped. */
      userId: string;
      actions: BlockAction[];
      /**
       * Current values of every stateful element on the message, keyed
       * block_id → action_id → selected values. Slack sends it with every
       * interaction on a message; absent on older payloads.
       */
      state?: Record<string, Record<string, string[]>>;
    };

// The agent side of the bridge is the shared client package; the engine
// programs against its interface and tests stub it.
export type { A2AEvent, AgentClient } from "@thicket/a2a-client";

export type SlackSessionStatus = "processing" | "active" | "suspended";

/** One thread message, trimmed to what a replayed transcript needs. */
export interface ThreadMessage {
  ts: string;
  /** Slack user id of the author, when a person (or bot user) posted. */
  authorId?: string;
  /** Present when the message was posted through an app. */
  botId?: string;
  text: string;
}

/** The Slack surface the bridge writes to. Stubbed in tests. */
export interface SlackApi {
  setStatus(
    channel: string,
    threadTs: string,
    status: SlackSessionStatus,
    options?: { title?: string },
  ): Promise<void>;
  /** The line of prose under the app's name; "" clears it. */
  setThreadStatus(channel: string, threadTs: string, status: string): Promise<void>;
  /** Whether a user id belongs to a bot. Cached; asked only when ambiguous. */
  isBotUser(userId: string): Promise<boolean>;
  postMessage(channel: string, threadTs: string, text: string): Promise<void>;
  /**
   * A Block Kit message in the thread; `text` is the notification
   * fallback. Resolves to the posted message's ts, the handle a later
   * update needs.
   */
  postBlocks(channel: string, threadTs: string, text: string, blocks: unknown[]): Promise<string>;
  /** chat.update: replace a posted message's blocks and fallback text. */
  updateMessage(channel: string, messageTs: string, text: string, blocks: unknown[]): Promise<void>;
  /**
   * chat.startStream → stream ts used for appends. `recipient` is the
   * user the stream answers; Slack requires it (with the team id) when
   * streaming anywhere that is not a DM.
   */
  startStream(channel: string, threadTs: string, recipient?: string): Promise<string>;
  appendStream(channel: string, streamTs: string, text: string): Promise<void>;
  /** A step the agent took, rendered as a card on the open stream. */
  appendActivity(channel: string, streamTs: string, activity: AgentActivity): Promise<void>;
  stopStream(channel: string, streamTs: string): Promise<void>;
  /** A thread's messages, oldest first, for replaying to a stateless agent. */
  replies(channel: string, threadTs: string, limit?: number): Promise<ThreadMessage[]>;
  /** reactions.add: `emoji` is the bare name, no colons. */
  addReaction(channel: string, messageTs: string, emoji: string): Promise<void>;
  /** A channel's name without the #, or undefined if Slack has none for it. Cached. */
  channelName(channel: string): Promise<string | undefined>;
}

// Metadata keys and the activity shape are thicket's A2A extension; the
// executor package owns their definitions so the two ends cannot drift.
export {
  META_QUEUED_TURN_COUNT,
  META_QUESTIONS,
  META_SHOULD_QUERY,
  META_SLACK_CHANNEL,
  META_SLACK_THREAD,
  META_WORKSPACE,
} from "@thicket/executor";
export type { AgentActivity, AgentQuestion } from "@thicket/executor";
