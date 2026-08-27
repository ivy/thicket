import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { SlackMessage, SlackTestClient } from "./client.js";

export interface SlackTestDeps {
  client: SlackTestClient;
  /** Injectable so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_MS = 1_500;

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function failure(err: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
  };
}

/** Renders a message the way a test wants to read it: shape, not prose. */
function describe(message: SlackMessage): string {
  const kinds = message.blocks
    .map((block) => (block as { type?: string }).type ?? "?")
    .join(",");
  const parts = [
    `ts=${message.ts}`,
    message.botId === undefined ? `user=${message.user ?? "?"}` : `bot=${message.botId}`,
  ];
  if (kinds !== "") {
    parts.push(`blocks=[${kinds}]`);
  }
  if (message.files.length > 0) {
    parts.push(`files=[${message.files.map((file) => file.name).join(",")}]`);
  }
  return `${parts.join(" ")}\n${message.text}`;
}

/**
 * Slack as a test instrument.
 *
 * This exists so an unattended build loop can do what only a human could
 * before: say something to an agent and check what actually came back —
 * reply text, task cards, thread title, reactions, uploaded files. It acts
 * as the operator, and it is a development tool, not part of the fleet.
 */
export function buildSlackTestServer(deps: SlackTestDeps): McpServer {
  const { client } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const server = new McpServer({ name: "thicket-slack-test", version: "0.1.0" });

  server.registerTool(
    "slack_whoami",
    { description: "Which Slack user this harness acts as. Start here.", inputSchema: {} },
    async () => {
      try {
        const me = await client.whoami();
        return text(`user_id=${me.userId} team=${me.team}`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "slack_dm_agent",
    {
      description:
        "Send a DM to a thicket agent as the operator, which is what starts " +
        "a turn — a bot token cannot, since the bridge ignores bot messages. " +
        "Returns the message ts, which is also the thread root.",
      inputSchema: {
        agent: z.string().describe("agent name, e.g. hearth"),
        text: z.string().describe("what to say"),
        thread_ts: z.string().optional().describe("reply into an existing thread"),
      },
    },
    async ({ agent, text: body, thread_ts }) => {
      try {
        const channel = await client.dmChannelFor(agent);
        const ts = await client.post(channel, body, thread_ts);
        return text(`channel=${channel} ts=${ts}`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "slack_post",
    {
      description: "Post to a channel by name or id, as the operator.",
      inputSchema: {
        channel: z.string().describe("#name or channel id"),
        text: z.string(),
        thread_ts: z.string().optional(),
      },
    },
    async ({ channel, text: body, thread_ts }) => {
      try {
        const id = channel.startsWith("C") || channel.startsWith("D")
          ? channel
          : await client.channelIdFor(channel);
        const ts = await client.post(id, body, thread_ts);
        return text(`channel=${id} ts=${ts}`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "slack_upload",
    {
      description:
        "Upload a local file to a channel or an agent's DM, as the operator. " +
        "Use to exercise attachment handling end to end.",
      inputSchema: {
        channel: z.string().describe("#name, channel id, or agent: prefix for a DM"),
        path: z.string().describe("absolute path to a local file"),
        comment: z.string().optional().describe("message to send with it"),
        thread_ts: z.string().optional(),
      },
    },
    async ({ channel, path, comment, thread_ts }) => {
      try {
        const id = channel.startsWith("agent:")
          ? await client.dmChannelFor(channel.slice("agent:".length))
          : channel.startsWith("C") || channel.startsWith("D")
            ? channel
            : await client.channelIdFor(channel);
        const bytes = readFileSync(path);
        const name = path.split("/").pop() ?? "attachment";
        const fileId = await client.upload(id, name, bytes, thread_ts, comment);
        return text(`channel=${id} file_id=${fileId} bytes=${bytes.length}`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "slack_await_reply",
    {
      description:
        "Block until the agent answers in a thread, then return what it said " +
        "with its block structure. This is the assertion most live tests want: " +
        "an agent turn is asynchronous and finishes when it finishes.",
      inputSchema: {
        channel: z.string().describe("channel id from slack_dm_agent"),
        thread_ts: z.string().describe("thread root ts"),
        after_ts: z
          .string()
          .optional()
          .describe("ignore replies at or before this ts; defaults to the root"),
        timeout_ms: z.number().optional(),
      },
    },
    async ({ channel, thread_ts, after_ts, timeout_ms }) => {
      const deadline = now() + (timeout_ms ?? DEFAULT_TIMEOUT_MS);
      const floor = after_ts ?? thread_ts;
      try {
        for (;;) {
          const messages = await client.replies(channel, thread_ts);
          // The agent's replies are the bot's; the operator's own message
          // is not an answer to itself.
          const reply = messages.find(
            (message) => message.botId !== undefined && message.ts > floor,
          );
          if (reply !== undefined) {
            return text(describe(reply));
          }
          if (now() >= deadline) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text:
                    `no agent reply in thread ${thread_ts} within the timeout. ` +
                    `${messages.length} message(s) present — check the bridge log ` +
                    `for a "slack event" line to tell a lost event from a slow turn.`,
                },
              ],
            };
          }
          await sleep(POLL_MS);
        }
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "slack_thread",
    {
      description:
        "Every message in a thread, with block structure and files. Use to " +
        "assert on task cards, streamed output, and attachments.",
      inputSchema: { channel: z.string(), thread_ts: z.string() },
    },
    async ({ channel, thread_ts }) => {
      try {
        const messages = await client.replies(channel, thread_ts);
        return text(messages.map(describe).join("\n---\n"));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "slack_history",
    {
      description: "Recent messages in a channel, newest first.",
      inputSchema: { channel: z.string(), limit: z.number().optional() },
    },
    async ({ channel, limit }) => {
      try {
        const id = channel.startsWith("C") || channel.startsWith("D")
          ? channel
          : await client.channelIdFor(channel);
        const messages = await client.history(id, limit ?? 20);
        return text(messages.map(describe).join("\n---\n"));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "slack_reactions",
    {
      description: "Emoji reactions on one message, for verifying agent reactions.",
      inputSchema: { channel: z.string(), ts: z.string() },
    },
    async ({ channel, ts }) => {
      try {
        const names = await client.reactions(channel, ts);
        return text(names.length === 0 ? "(none)" : names.join(", "));
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}
