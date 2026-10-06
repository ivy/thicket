import {
  CALLBACK,
  type CardBody,
  type ChannelInfo,
  type DiscordApi,
  type FetchedMessage,
  type HistoryMessage,
  type PlainMessage,
} from "./api.js";
import { EPHEMERAL, SUPPRESS_NOTIFICATIONS } from "./card.js";
import { DiscordApiError, type DiscordRest } from "./rest.js";
import { parseAttachments, translateMessage } from "./translate.js";

/** "Message already has a thread": the race between mentioned agents, lost. */
const MESSAGE_ALREADY_HAS_THREAD = 160004;

/** A day: a post into an archived thread unarchives it, and a server holds 1,000 active threads. */
const AUTO_ARCHIVE_MINUTES = 1440;

/** Thread names are 1 to 100 characters. */
const THREAD_NAME_MAX = 100;

export function threadName(text: string): string {
  const flat = text
    .replace(/<@[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat === "") {
    return "conversation";
  }
  return flat.length <= THREAD_NAME_MAX ? flat : `${flat.slice(0, THREAD_NAME_MAX - 1)}…`;
}

/**
 * The Discord surface over the REST client. Nothing here decides anything;
 * it carries the engine's intent to the right route and hands back ids.
 */
export class RestDiscordApi implements DiscordApi {
  private readonly channels = new Map<string, ChannelInfo>();

  constructor(private readonly rest: DiscordRest) {}

  async channelInfo(channelId: string): Promise<ChannelInfo> {
    const known = this.channels.get(channelId);
    if (known !== undefined) {
      return known;
    }
    const raw = await this.rest.get<{ id: string; type: number; guild_id?: string; parent_id?: string | null }>(
      `/channels/${channelId}`,
    );
    const info: ChannelInfo = {
      id: raw.id,
      type: raw.type,
      ...(raw.guild_id === undefined ? {} : { guildId: raw.guild_id }),
      ...(raw.parent_id === undefined || raw.parent_id === null ? {} : { parentId: raw.parent_id }),
    };
    this.channels.set(channelId, info);
    return info;
  }

  /** A thread the bridge learned of without asking, from a dispatch or its own creation. */
  rememberChannel(info: ChannelInfo): void {
    this.channels.set(info.id, info);
  }

  async createThread(channelId: string, messageId: string, name: string): Promise<string> {
    try {
      const thread = await this.rest.post<{ id: string; type: number; guild_id?: string; parent_id?: string }>(
        `/channels/${channelId}/messages/${messageId}/threads`,
        { name, auto_archive_duration: AUTO_ARCHIVE_MINUTES },
      );
      this.rememberChannel({
        id: thread.id,
        type: thread.type,
        ...(thread.guild_id === undefined ? {} : { guildId: thread.guild_id }),
        parentId: thread.parent_id ?? channelId,
      });
      return thread.id;
    } catch (err) {
      if (err instanceof DiscordApiError && err.code === MESSAGE_ALREADY_HAS_THREAD) {
        const message = await this.fetchMessage(channelId, messageId);
        if (message.threadId !== undefined) {
          return message.threadId;
        }
      }
      throw err;
    }
  }

  async postCard(channelId: string, body: CardBody): Promise<string> {
    const posted = await this.rest.post<{ id: string }>(`/channels/${channelId}/messages`, body);
    return posted.id;
  }

  async editCard(channelId: string, messageId: string, body: CardBody): Promise<void> {
    await this.rest.patch(`/channels/${channelId}/messages/${messageId}`, {
      flags: body.flags,
      components: body.components,
      allowed_mentions: body.allowed_mentions,
    });
  }

  async postMessage(channelId: string, message: PlainMessage): Promise<string> {
    const posted = await this.rest.post<{ id: string }>(`/channels/${channelId}/messages`, {
      content: message.text,
      allowed_mentions: { parse: [], replied_user: message.ping === true },
      ...(message.replyTo === undefined
        ? {}
        : { message_reference: { message_id: message.replyTo, fail_if_not_exists: false } }),
      ...(message.silent === true ? { flags: SUPPRESS_NOTIFICATIONS } : {}),
    });
    return posted.id;
  }

  async typing(channelId: string): Promise<void> {
    await this.rest.post(`/channels/${channelId}/typing`);
  }

  async respond(interactionId: string, token: string, type: number, data?: unknown): Promise<void> {
    await this.rest.post(`/interactions/${interactionId}/${token}/callback`, { type, data });
  }

  async respondEphemeral(interactionId: string, token: string, text: string): Promise<void> {
    await this.respond(interactionId, token, CALLBACK.CHANNEL_MESSAGE, {
      content: text,
      flags: EPHEMERAL,
      allowed_mentions: { parse: [] },
    });
  }

  async readMessages(channelId: string, limit: number): Promise<HistoryMessage[]> {
    const raw = await this.rest.get<Record<string, unknown>[]>(
      `/channels/${channelId}/messages?limit=${Math.min(100, Math.max(1, limit))}`,
    );
    // Discord returns newest first.
    return raw
      .map((m) => translateMessage(m))
      .filter((m) => m !== undefined)
      .map((m) => ({ id: m.messageId, authorId: m.authorId, authorIsApp: m.authorIsApp, text: m.text }))
      .reverse();
  }

  async fetchMessage(channelId: string, messageId: string): Promise<FetchedMessage> {
    const raw = await this.rest.get<{ id: string; channel_id: string; attachments?: unknown; thread?: { id: string } }>(
      `/channels/${channelId}/messages/${messageId}`,
    );
    return {
      id: raw.id,
      channelId: raw.channel_id,
      attachments: parseAttachments(raw.attachments),
      ...(raw.thread === undefined ? {} : { threadId: raw.thread.id }),
    };
  }
}
