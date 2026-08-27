import { WebClient } from "@slack/web-api";

import type { AgentActivity, SlackApi, SlackSessionStatus } from "./types.js";

export interface SlackApiLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
}

/** Activity status names, in the vocabulary Slack's task cards use. */
const CARD_STATUS = {
  running: "in_progress",
  done: "complete",
  failed: "error",
} as const;

/**
 * SlackApi over @slack/web-api. Uses agents.sessions.* — the session
 * lifecycle surface that raises the loading indicator and the stop button —
 * rather than the free-text assistant.threads.* variant Slack documents as
 * headed for deprecation. Progressive output goes through the chat
 * streaming trio.
 */
export class WebSlackApi implements SlackApi {
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

  async postMessage(channel: string, threadTs: string, text: string): Promise<void> {
    this.log("chat.postMessage", { channel, thread_ts: threadTs, text });
    await this.web.chat.postMessage({ channel, thread_ts: threadTs, text });
  }

  async startStream(channel: string, threadTs: string): Promise<string> {
    const res = (await this.call("chat.startStream", {
      channel,
      thread_ts: threadTs,
      task_display_mode: "timeline",
    })) as { ts?: string };
    if (res.ts === undefined) {
      throw new Error("chat.startStream returned no ts");
    }
    return res.ts;
  }

  async appendStream(channel: string, streamTs: string, text: string): Promise<void> {
    await this.call("chat.appendStream", { channel, ts: streamTs, markdown_text: text });
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
        },
      ],
    });
  }

  async stopStream(channel: string, streamTs: string): Promise<void> {
    await this.call("chat.stopStream", { channel, ts: streamTs });
  }

  private async call(method: string, args: Record<string, unknown>): Promise<unknown> {
    this.log(method, args);
    return this.web.apiCall(method, args);
  }

  /**
   * One line per Slack side effect. Message bodies are reduced to a length
   * so a turn stays reconstructible from the log without copying its
   * content there.
   */
  private log(method: string, args: Record<string, unknown>): void {
    const fields: Record<string, unknown> = { method };
    for (const [key, value] of Object.entries(args)) {
      if (key === "markdown_text" || key === "text") {
        fields.chars = String(value).length;
      } else if (key === "title") {
        fields.titled = true;
      } else if (key === "chunks") {
        fields.chunks = (value as { type: string; id?: string; status?: string }[]).map((chunk) =>
          chunk.id === undefined ? chunk.type : `${chunk.id}:${chunk.status}`,
        );
      } else {
        fields[key] = value;
      }
    }
    this.logger.info("slack call", fields);
  }
}
