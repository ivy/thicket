import { WebClient } from "@slack/web-api";

import type { AgentActivity, SlackApi, SlackSessionStatus, ThreadMessage } from "./types.js";

export interface SlackApiLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * Slack's own behaviour past ~4,000 characters is to split the message
 * itself, at any point it likes — observed mid-word. Splitting below
 * that threshold, at boundaries a reader can live with, keeps the choice
 * of break ours.
 */
export const POST_TEXT_MAX = 3_500;

/**
 * Splits text into pieces of at most `max` characters, preferring
 * paragraph breaks, then line breaks, then spaces; a single unbroken run
 * longer than `max` is hard-cut rather than looping forever.
 */
export function splitText(text: string, max: number = POST_TEXT_MAX): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    const cut =
      lastBoundary(window, "\n\n") ?? lastBoundary(window, "\n") ?? lastBoundary(window, " ") ?? max;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[ \n]+/, "");
  }
  if (rest !== "") {
    pieces.push(rest);
  }
  return pieces;
}

function lastBoundary(window: string, separator: string): number | undefined {
  const at = window.lastIndexOf(separator);
  return at > 0 ? at : undefined;
}

/** Activity status names, in the vocabulary Slack's task cards use. */
const CARD_STATUS = {
  running: "in_progress",
  done: "complete",
  failed: "error",
} as const;

/**
 * SlackApi over @slack/web-api. The two status methods are complementary,
 * not alternatives: agents.sessions.setStatus drives the session lifecycle
 * (loading indicator, stop button) and assistant.threads.setStatus writes
 * the line of prose shown under the app's name. Progressive output goes
 * through the chat streaming trio.
 */
export class WebSlackApi implements SlackApi {
  private readonly botUsers = new Map<string, boolean>();

  constructor(
    private readonly web: WebClient,
    private readonly logger: SlackApiLogger = { info: () => {} },
  ) {}

  async setStatus(
    channel: string,
    threadTs: string,
    status: SlackSessionStatus,
    options?: { title?: string },
  ): Promise<void> {
    await this.call("agents.sessions.setStatus", {
      channel_id: channel,
      thread_ts: threadTs,
      status,
      ...(options?.title === undefined ? {} : { title: options.title }),
    });
  }

  /**
   * Cached because the answer never changes for a given id, and the guard
   * asks on every app-stamped message.
   */
  async isBotUser(userId: string): Promise<boolean> {
    const cached = this.botUsers.get(userId);
    if (cached !== undefined) {
      return cached;
    }
    const res = (await this.call("users.info", { user: userId })) as {
      user?: { is_bot?: boolean };
    };
    const isBot = res.user?.is_bot === true;
    this.botUsers.set(userId, isBot);
    return isBot;
  }

  async setThreadStatus(channel: string, threadTs: string, status: string): Promise<void> {
    await this.call("assistant.threads.setStatus", {
      channel_id: channel,
      thread_ts: threadTs,
      status,
    });
  }

  async postMessage(channel: string, threadTs: string, text: string): Promise<void> {
    // markdown_text, not text: the model writes markdown, and `text` is
    // parsed as mrkdwn — a different dialect that renders `##` and `**`
    // literally (observed live on a fallback post). Sequential, so the
    // pieces read in order.
    for (const piece of splitText(text)) {
      await this.call("chat.postMessage", {
        channel,
        thread_ts: threadTs,
        markdown_text: piece,
      });
    }
  }

  async postBlocks(
    channel: string,
    threadTs: string,
    text: string,
    blocks: unknown[],
  ): Promise<string> {
    const res = (await this.call("chat.postMessage", {
      channel,
      thread_ts: threadTs,
      text,
      blocks,
    })) as { ts?: string };
    if (res.ts === undefined) {
      throw new Error("chat.postMessage returned no ts");
    }
    return res.ts;
  }

  async updateMessage(
    channel: string,
    messageTs: string,
    text: string,
    blocks: unknown[],
  ): Promise<void> {
    await this.call("chat.update", { channel, ts: messageTs, text, blocks });
  }

  async startStream(channel: string, threadTs: string, recipient?: string): Promise<string> {
    const res = (await this.call("chat.startStream", {
      channel,
      thread_ts: threadTs,
      task_display_mode: "timeline",
      ...(await this.recipientFields(channel, recipient)),
    })) as { ts?: string };
    if (res.ts === undefined) {
      throw new Error("chat.startStream returned no ts");
    }
    return res.ts;
  }

  /** Cached team id for recipient_team_id; null when auth.test failed. */
  private teamId: string | null | undefined;

  /**
   * Slack requires recipient_user_id and recipient_team_id when streaming
   * to a channel; in a DM the recipient is the DM and the fields are
   * omitted so that path stays exactly as it always was. The team id
   * comes from auth.test, asked once per process.
   */
  private async recipientFields(
    channel: string,
    recipient: string | undefined,
  ): Promise<Record<string, string>> {
    if (recipient === undefined || channel.startsWith("D")) {
      return {};
    }
    if (this.teamId === undefined) {
      try {
        const res = (await this.call("auth.test", {})) as { team_id?: string };
        this.teamId = typeof res.team_id === "string" ? res.team_id : null;
      } catch {
        this.teamId = null;
      }
    }
    return {
      recipient_user_id: recipient,
      ...(this.teamId === null ? {} : { recipient_team_id: this.teamId }),
    };
  }

  /**
   * Text goes through `chunks` like everything else: a stream that has
   * carried a chunk rejects the top-level markdown_text form with
   * streaming_mode_mismatch (observed live).
   */
  async appendStream(channel: string, streamTs: string, text: string): Promise<void> {
    await this.call("chat.appendStream", {
      channel,
      ts: streamTs,
      chunks: [{ type: "markdown_text", text }],
    });
  }

  async appendActivity(
    channel: string,
    streamTs: string,
    activity: AgentActivity,
  ): Promise<void> {
    await this.call("chat.appendStream", {
      channel,
      ts: streamTs,
      chunks: [
        {
          type: "task_update",
          id: activity.id,
          title: activity.title,
          status: CARD_STATUS[activity.status],
          ...(activity.details === undefined ? {} : { details: activity.details }),
          ...(activity.icon === undefined ? {} : { icon: { type: "icon", name: activity.icon } }),
        },
      ],
    });
  }

  async stopStream(channel: string, streamTs: string): Promise<void> {
    await this.call("chat.stopStream", { channel, ts: streamTs });
  }

  async addReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
    await this.call("reactions.add", { channel, timestamp: messageTs, name: emoji });
  }

  async replies(channel: string, threadTs: string, limit = 50): Promise<ThreadMessage[]> {
    const res = (await this.call("conversations.replies", {
      channel,
      ts: threadTs,
      limit,
    })) as { messages?: Record<string, unknown>[] };
    return (res.messages ?? []).map((raw) => ({
      ts: String(raw.ts ?? ""),
      ...(typeof raw.user === "string" ? { authorId: raw.user } : {}),
      ...(typeof raw.bot_id === "string" ? { botId: raw.bot_id } : {}),
      text: typeof raw.text === "string" ? raw.text : "",
    }));
  }

  private async call(method: string, args: Record<string, unknown>): Promise<unknown> {
    this.log(method, args);
    return this.web.apiCall(method, args);
  }

  /**
   * One line per Slack side effect, nested under `slack` so an argument
   * named `ts` cannot shadow the log record's own timestamp. Message bodies
   * are reduced to a length: a turn stays reconstructible without its
   * content being copied into the log.
   */
  private log(method: string, args: Record<string, unknown>): void {
    const fields: Record<string, unknown> = { method };
    for (const [key, value] of Object.entries(args)) {
      if (key === "text" || key === "markdown_text") {
        fields.chars = String(value).length;
      } else if (key === "title") {
        fields.titled = true;
      } else if (key === "blocks") {
        fields.blocks = (value as { type?: string }[]).map((block) => String(block.type ?? "?"));
      } else if (key === "chunks") {
        fields.chunks = (value as { type: string; id?: string; status?: string; text?: string }[]).map(
          (chunk) =>
            chunk.id !== undefined
              ? `${chunk.id}:${chunk.status}`
              : `${chunk.type}:${String(chunk.text ?? "").length}`,
        );
      } else {
        fields[key] = value;
      }
    }
    this.logger.info("slack call", { slack: fields });
  }
}
