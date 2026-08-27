import { WebClient } from "@slack/web-api";

import type { SlackApi, SlackSessionStatus } from "./types.js";

/**
 * SlackApi over @slack/web-api. Uses agents.sessions.* (the
 * assistant.threads.* equivalents are deprecated) and the chat streaming
 * trio for progressive output.
 */
export class WebSlackApi implements SlackApi {
  constructor(private readonly web: WebClient) {}

  async setStatus(
    channel: string,
    threadTs: string,
    status: SlackSessionStatus,
  ): Promise<void> {
    await this.web.apiCall("agents.sessions.setStatus", {
      channel_id: channel,
      thread_ts: threadTs,
      status,
    });
  }

  async postMessage(channel: string, threadTs: string, text: string): Promise<void> {
    await this.web.chat.postMessage({ channel, thread_ts: threadTs, text });
  }

  async startStream(channel: string, threadTs: string): Promise<string> {
    const res = (await this.web.apiCall("chat.startStream", {
      channel,
      thread_ts: threadTs,
    })) as { ts?: string };
    if (res.ts === undefined) {
      throw new Error("chat.startStream returned no ts");
    }
    return res.ts;
  }

  async appendStream(channel: string, streamTs: string, text: string): Promise<void> {
    await this.web.apiCall("chat.appendStream", {
      channel,
      ts: streamTs,
      markdown_text: text,
    });
  }

  async stopStream(channel: string, streamTs: string): Promise<void> {
    await this.web.apiCall("chat.stopStream", { channel, ts: streamTs });
  }
}
