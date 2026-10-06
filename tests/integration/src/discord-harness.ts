import { RemoteAgentClient } from "@thicket/a2a-client";
import {
  BridgeEngine,
  BridgeState,
  type CardBody,
  type ChannelInfo,
  type DiscordApi,
  type HistoryMessage,
  type MessageEvent,
  type PlainMessage,
} from "@thicket/discord";

import { netdFetch, type RunningAgent } from "./harness.js";

export const BOT = "bot-1";
export const OPERATOR = "op-1";
export const GUILD = "guild-1";
export const DM = "dm-1";
export const CHANNEL = "chan-1";

export type DiscordCall =
  | { type: "postCard"; channel: string; body: CardBody; id: string }
  | { type: "editCard"; channel: string; id: string; body: CardBody }
  | { type: "post"; channel: string; message: PlainMessage; id: string }
  | { type: "createThread"; channel: string; messageId: string; name: string; id: string }
  | { type: "typing"; channel: string }
  | { type: "respond"; interactionId: string; callback: number }
  | { type: "ephemeral"; interactionId: string; text: string };

/** The Discord surface, recording what the engine asked of it. */
export class MockDiscord implements DiscordApi {
  calls: DiscordCall[] = [];
  channels = new Map<string, ChannelInfo>([
    [CHANNEL, { id: CHANNEL, type: 0, guildId: GUILD }],
    [DM, { id: DM, type: 1 }],
  ]);
  private counter = 0;

  async channelInfo(channelId: string): Promise<ChannelInfo> {
    const info = this.channels.get(channelId);
    if (info === undefined) {
      throw new Error(`unknown channel ${channelId}`);
    }
    return info;
  }
  async createThread(channel: string, messageId: string, name: string): Promise<string> {
    const id = `thread-${messageId}`;
    this.channels.set(id, { id, type: 11, guildId: GUILD, parentId: channel });
    this.calls.push({ type: "createThread", channel, messageId, name, id });
    return id;
  }
  async postCard(channel: string, body: CardBody): Promise<string> {
    const id = `card-${++this.counter}`;
    this.calls.push({ type: "postCard", channel, body, id });
    return id;
  }
  async editCard(channel: string, id: string, body: CardBody): Promise<void> {
    this.calls.push({ type: "editCard", channel, id, body });
  }
  async postMessage(channel: string, message: PlainMessage): Promise<string> {
    const id = `msg-${++this.counter}`;
    this.calls.push({ type: "post", channel, message, id });
    return id;
  }
  async typing(channel: string): Promise<void> {
    this.calls.push({ type: "typing", channel });
  }
  async respond(interactionId: string, _token: string, callback: number): Promise<void> {
    this.calls.push({ type: "respond", interactionId, callback });
  }
  async respondEphemeral(interactionId: string, _token: string, text: string): Promise<void> {
    this.calls.push({ type: "ephemeral", interactionId, text });
  }
  async fetchMessage(channelId: string, messageId: string) {
    return { id: messageId, channelId, attachments: [] };
  }
  async readMessages(): Promise<HistoryMessage[]> {
    return [];
  }

  /** Every Text Display drawn on a card, in order, by card id. */
  displays(id: string): string[][] {
    return this.calls
      .filter((c) => (c.type === "postCard" || c.type === "editCard") && c.id === id)
      .map((c) => {
        const out: string[] = [];
        const visit = (component: unknown) => {
          const node = component as Record<string, unknown>;
          if (node.type === 10) {
            out.push(String(node.content));
          }
          if (Array.isArray(node.components)) {
            node.components.forEach(visit);
          }
        };
        (c as { body: CardBody }).body.components.forEach(visit);
        return out;
      });
  }
  cards(): string[] {
    return this.calls.filter((c) => c.type === "postCard").map((c) => (c as { id: string }).id);
  }
  /** The answer text as the card last showed it. */
  answer(id: string): string {
    return this.displays(id).at(-1)?.at(-1) ?? "";
  }
}

export function dm(text: string, messageId: string): MessageEvent {
  return {
    kind: "message",
    channel: DM,
    messageId,
    text,
    authorId: OPERATOR,
    authorIsApp: false,
    mentions: [],
    botMentions: [],
    mentionNames: {},
    files: [],
    type: 0,
    forwards: [],
  };
}

export interface RunningDiscordBridge {
  engine: BridgeEngine;
  discord: MockDiscord;
  state: BridgeState;
}

export function startDiscordBridge(agent: RunningAgent, dbPath = ":memory:"): RunningDiscordBridge {
  const discord = new MockDiscord();
  const state = new BridgeState(dbPath);
  const engine = new BridgeEngine({
    agent: agent.name,
    guildId: GUILD,
    operators: [OPERATOR],
    selfId: () => BOT,
    queueing: "harness",
    client: new RemoteAgentClient(agent.url, netdFetch()),
    discord,
    state,
    editIntervalMs: 1,
  });
  return { engine, discord, state };
}
