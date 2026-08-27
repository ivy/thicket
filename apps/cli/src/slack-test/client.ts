/**
 * The slice of Slack's Web API the live-test harness uses, on a *user*
 * token. A user token because the bridge drops `bot_id` messages so agents
 * cannot answer themselves — which also means nothing holding a bot token
 * can trigger a turn, and a test that cannot trigger a turn is not a test.
 */
export interface SlackTestClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
}

export interface SlackMessage {
  ts: string;
  user?: string;
  botId?: string;
  text: string;
  /** Block Kit payload, where task cards and streamed structure live. */
  blocks: unknown[];
  files: { id: string; name: string }[];
  threadTs?: string;
}

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`${method} failed: ${code}`);
    this.name = "SlackApiError";
  }
}

interface SlackEnvelope {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export class SlackTestClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SlackTestClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call(method: string, params: Record<string, string> = {}): Promise<SlackEnvelope> {
    const response = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        authorization: `Bearer ${this.token}`,
      },
      body: new URLSearchParams(params).toString(),
    });
    const payload = (await response.json()) as SlackEnvelope;
    if (!payload.ok) {
      throw new SlackApiError(method, String(payload.error ?? "unknown_error"));
    }
    return payload;
  }


  /**
   * The DM channel with an agent's bot user.
   *
   * Found by listing rather than opening: `conversations.open` needs
   * `im:write`, and the harness deliberately holds only read scopes plus
   * `chat:write`. An agent worth testing has been spoken to at least once,
   * so its DM exists.
   */
  async dmChannelFor(agent: string): Promise<string> {
    const botId = await this.botUserId(agent);
    let cursor = "";
    for (;;) {
      const res = await this.call("conversations.list", {
        types: "im",
        limit: "200",
        ...(cursor === "" ? {} : { cursor }),
      });
      const ims = (res.channels ?? []) as { id: string; user?: string }[];
      const hit = ims.find((im) => im.user === botId);
      if (hit !== undefined) {
        return hit.id;
      }
      cursor = String(
        (res.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "",
      );
      if (cursor === "") {
        throw new Error(
          `no open DM with ${agent} (bot user ${botId}). Send it one message by ` +
            `hand, or open the conversation with Slack's own MCP server, which ` +
            `holds im:write; this harness does not.`,
        );
      }
    }
  }

  private async botUserId(agent: string): Promise<string> {
    const users = await this.call("users.list", { limit: "500" });
    const members = (users.members ?? []) as {
      id: string;
      name?: string;
      is_bot?: boolean;
      profile?: { real_name?: string; display_name?: string };
    }[];
    const wanted = agent.toLowerCase();
    const bot = members.find(
      (member) =>
        member.is_bot === true &&
        [member.name, member.profile?.real_name, member.profile?.display_name]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase() === wanted),
    );
    if (bot === undefined) {
      throw new Error(`no bot user named ${agent} in this workspace; is the app installed?`);
    }
    return bot.id;
  }

  async channelIdFor(name: string): Promise<string> {
    const wanted = name.replace(/^#/, "");
    let cursor = "";
    for (;;) {
      const res = await this.call("conversations.list", {
        limit: "200",
        exclude_archived: "true",
        types: "public_channel,private_channel",
        ...(cursor === "" ? {} : { cursor }),
      });
      const channels = (res.channels ?? []) as { id: string; name: string }[];
      const hit = channels.find((channel) => channel.name === wanted);
      if (hit !== undefined) {
        return hit.id;
      }
      cursor = String(
        (res.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "",
      );
      if (cursor === "") {
        throw new Error(`no channel named ${name} visible to this token`);
      }
    }
  }

  async post(channel: string, text: string, threadTs?: string): Promise<string> {
    const res = await this.call("chat.postMessage", {
      channel,
      text,
      ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
    });
    return String(res.ts ?? "");
  }

  async replies(channel: string, threadTs: string): Promise<SlackMessage[]> {
    const res = await this.call("conversations.replies", {
      channel,
      ts: threadTs,
      limit: "100",
    });
    return ((res.messages ?? []) as Record<string, unknown>[]).map(toMessage);
  }



  /**
   * Upload via the external flow (getUploadURLExternal → POST →
   * completeUploadExternal); files.upload itself is retired.
   */
  async upload(
    channel: string,
    filename: string,
    bytes: Uint8Array,
    threadTs?: string,
    comment?: string,
  ): Promise<string> {
    const ticket = await this.call("files.getUploadURLExternal", {
      filename,
      length: String(bytes.length),
    });
    const uploadUrl = String(ticket.upload_url ?? "");
    const fileId = String(ticket.file_id ?? "");
    const put = await this.fetchImpl(uploadUrl, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Blob([bytes]),
    });
    if (!put.ok) {
      throw new Error(`upload POST failed: ${put.status}`);
    }
    await this.call("files.completeUploadExternal", {
      files: JSON.stringify([{ id: fileId, title: filename }]),
      channel_id: channel,
      ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
      ...(comment === undefined ? {} : { initial_comment: comment }),
    });
    return fileId;
  }
}

function toMessage(raw: Record<string, unknown>): SlackMessage {
  return {
    ts: String(raw.ts ?? ""),
    ...(typeof raw.user === "string" ? { user: raw.user } : {}),
    ...(typeof raw.bot_id === "string" ? { botId: raw.bot_id } : {}),
    text: typeof raw.text === "string" ? raw.text : "",
    blocks: Array.isArray(raw.blocks) ? raw.blocks : [],
    files: Array.isArray(raw.files)
      ? (raw.files as Record<string, unknown>[]).map((file) => ({
          id: String(file.id ?? ""),
          name: String(file.name ?? ""),
        }))
      : [],
    ...(typeof raw.thread_ts === "string" ? { threadTs: raw.thread_ts } : {}),
  };
}
