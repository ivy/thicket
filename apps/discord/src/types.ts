import type { AgentActivity } from "@thicket/executor";

export interface EngineLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/** An upload on a Discord message: a signed CDN URL that expires. */
export interface DiscordAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
}

/**
 * A message as the Gateway delivered it, with the facts the turn table reads
 * and nothing it does not. Whether it is a turn is the engine's call: that
 * needs the operator list, the engine's own bot id, and whether the thread
 * is engaged, none of which the translator has.
 */
export interface MessageEvent {
  kind: "message";
  channel: string;
  /** Absent in a DM. */
  guild?: string;
  messageId: string;
  text: string;
  authorId: string;
  /** The author's display name, as Discord offered it with the message. */
  authorName?: string;
  /** `author.bot`, or a `webhook_id`: the loop guard's whole input. */
  authorIsApp: boolean;
  /** User ids the message mentions; a reply with the ping on lists the replied-to author. */
  mentions: string[];
  /** The subset of `mentions` that are apps: other agents, or this one. */
  botMentions: string[];
  /** Names for the mentioned users, by id, where Discord gave them. */
  mentionNames: Record<string, string>;
  files: DiscordAttachment[];
  /** 0 default, 19 reply; anything else the engine ignores. */
  type: number;
  /** The message this one replies to, when it is a reply. */
  replyTo?: string;
  /** The replied-to message as Discord delivered it alongside the reply. */
  reply?: { author?: { id: string; name?: string; isApp: boolean }; text?: string; files: DiscordAttachment[] };
  /** Messages forwarded with this one; Discord gives their content but not their author. */
  forwards: { text: string; files: DiscordAttachment[] }[];
}

/** A tap on something the bridge posted: a button or a select. */
export interface ComponentEvent {
  kind: "component";
  interactionId: string;
  token: string;
  channel: string;
  messageId: string;
  userId: string;
  customId: string;
  /** 2 button, 3 string select. */
  componentType: number;
  values: string[];
}

/** A submitted form. */
export interface ModalEvent {
  kind: "modal";
  interactionId: string;
  token: string;
  channel: string;
  /** The message whose button opened the form. */
  messageId?: string;
  userId: string;
  customId: string;
  fields: { customId: string; type: number; value?: string; values?: string[] }[];
  attachments: DiscordAttachment[];
}

/** A slash command. */
export interface CommandEvent {
  kind: "command";
  interactionId: string;
  token: string;
  channel: string;
  guild?: string;
  userId: string;
  name: string;
  options: Record<string, string>;
}

export type InboundEvent = MessageEvent | ComponentEvent | ModalEvent | CommandEvent;

export type { A2AEvent, AgentClient } from "@thicket/a2a-client";
export type { AgentActivity };
