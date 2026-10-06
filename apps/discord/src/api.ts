import type { DiscordAttachment } from "./types.js";

/** Channel types the turn table distinguishes. https://docs.discord.com/developers/resources/channel */
export const CHANNEL_TYPE = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_FORUM: 15,
  GUILD_MEDIA: 16,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
} as const;

export const THREAD_TYPES: ReadonlySet<number> = new Set([
  CHANNEL_TYPE.ANNOUNCEMENT_THREAD,
  CHANNEL_TYPE.PUBLIC_THREAD,
  CHANNEL_TYPE.PRIVATE_THREAD,
]);

export interface ChannelInfo {
  id: string;
  type: number;
  guildId?: string;
  /** The guild channel a thread hangs from. */
  parentId?: string;
}

/** The body of a card message: what renderCard produces, plus the reply reference. */
export interface CardBody {
  flags: number;
  components: unknown[];
  allowed_mentions: { parse: never[]; replied_user?: boolean };
  message_reference?: { message_id: string; fail_if_not_exists: false };
}

export interface PlainMessage {
  /** At most 2,000 characters; the engine splits. */
  text: string;
  /** Posted as a reply to this message. */
  replyTo?: string;
  /** Whether the reply pings its author. */
  ping?: boolean;
  silent?: boolean;
}

/** Interaction callback types the bridge sends. */
export const CALLBACK = {
  CHANNEL_MESSAGE: 4,
  DEFERRED_CHANNEL_MESSAGE: 5,
  DEFERRED_UPDATE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
} as const;

/** One message of a thread's history, trimmed to what a replayed transcript needs. */
export interface HistoryMessage {
  id: string;
  authorId: string;
  authorIsApp: boolean;
  text: string;
}

export interface FetchedMessage {
  id: string;
  channelId: string;
  attachments: DiscordAttachment[];
  /** The thread started from this message, if one exists. */
  threadId?: string;
}

/** The Discord surface the engine writes to. Stubbed in tests. */
export interface DiscordApi {
  /** A channel's type and parent, asked once per channel and remembered. */
  channelInfo(channelId: string): Promise<ChannelInfo>;
  /**
   * A public thread from a message, named. When the message already has
   * one — another agent's bot got there first — that thread's id.
   */
  createThread(channelId: string, messageId: string, name: string): Promise<string>;
  /** Post a card; resolves to its message id. */
  postCard(channelId: string, body: CardBody): Promise<string>;
  editCard(channelId: string, messageId: string, body: CardBody): Promise<void>;
  /** A plain message; resolves to its message id. */
  postMessage(channelId: string, message: PlainMessage): Promise<string>;
  /** The typing indicator, which Discord shows for ten seconds. */
  typing(channelId: string): Promise<void>;
  /** Answer an interaction within its three seconds. */
  respond(interactionId: string, token: string, type: number, data?: unknown): Promise<void>;
  /** An ephemeral reply to an interaction, for refusals and acknowledgements. */
  respondEphemeral(interactionId: string, token: string, text: string): Promise<void>;
  fetchMessage(channelId: string, messageId: string): Promise<FetchedMessage>;
  /** A channel's messages, oldest first, for replaying to a stateless agent. */
  readMessages(channelId: string, limit: number): Promise<HistoryMessage[]>;
}
