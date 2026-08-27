import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * Uploads are buffered through the bridge, so the cap protects two heaps.
 * It matches the bridge's own request limit; Slack's per-file cap is 1 GB.
 */
const UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

export interface ToolbeltOptions {
  /** The bridge's base URL on the tailnet; reached through netd egress. */
  bridgeBaseUrl: string;
  /** The egress fetch — the only route off this machine. */
  fetchImpl: typeof fetch;
  /** Session working directory; relative upload paths resolve here. */
  cwd: string;
}

/**
 * Outcome of a bridge call, in words the model can act on. `refused` is
 * the bridge answering an authorization question — retrying will not
 * help, but a different channel might. `failed` is transport or Slack
 * trouble that may be transient.
 */
export type ToolOutcome =
  | { outcome: "ok"; detail: Record<string, unknown> }
  | { outcome: "refused"; error: string }
  | { outcome: "failed"; error: string };

async function callBridge(
  options: ToolbeltOptions,
  path: string,
  init: RequestInit,
): Promise<ToolOutcome> {
  let response: globalThis.Response;
  try {
    response = await options.fetchImpl(`${options.bridgeBaseUrl}${path}`, init);
  } catch (err) {
    return {
      outcome: "failed",
      error: `bridge unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return { outcome: "failed", error: `bridge returned ${response.status} with no body` };
  }
  if (response.status === 403) {
    return { outcome: "refused", error: String(body.error ?? "refused") };
  }
  if (!response.ok) {
    return { outcome: "failed", error: String(body.error ?? `bridge returned ${response.status}`) };
  }
  return { outcome: "ok", detail: body };
}

export async function postMessage(
  options: ToolbeltOptions,
  args: { channel: string; text: string; thread_ts?: string },
): Promise<ToolOutcome> {
  return callBridge(options, "/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
}

export async function uploadFile(
  options: ToolbeltOptions,
  args: { path: string; channel: string; thread_ts?: string; comment?: string },
): Promise<ToolOutcome> {
  const filePath = isAbsolute(args.path) ? args.path : resolve(options.cwd, args.path);
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return { outcome: "failed", error: `no such file: ${filePath}` };
  }
  if (size === 0) {
    return { outcome: "failed", error: `refusing to upload an empty file: ${filePath}` };
  }
  if (size > UPLOAD_LIMIT_BYTES) {
    return {
      outcome: "failed",
      error: `file is ${size} bytes; the upload limit is ${UPLOAD_LIMIT_BYTES}`,
    };
  }
  const bytes = await readFile(filePath);
  const query = new URLSearchParams({
    channel: args.channel,
    filename: basename(filePath),
    ...(args.thread_ts === undefined ? {} : { thread_ts: args.thread_ts }),
    ...(args.comment === undefined ? {} : { comment: args.comment }),
  });
  return callBridge(options, `/api/files?${query.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
}

/** A GET against one of the bridge's read routes. */
export async function readBridge(
  options: ToolbeltOptions,
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<ToolOutcome> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const qs = query.toString();
  return callBridge(options, qs === "" ? path : `${path}?${qs}`, { method: "GET" });
}

/** Renders an outcome as a tool result the model can read and act on. */
export function toToolResult(outcome: ToolOutcome): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  if (outcome.outcome === "ok") {
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...outcome.detail }) }] };
  }
  const text =
    outcome.outcome === "refused"
      ? `Refused by the bridge: ${outcome.error}. This is an authorization decision — ` +
        `the app is not in that conversation (or it does not exist). Do not retry the ` +
        `same channel; tell the user what you needed.`
      : `Failed: ${outcome.error}. This may be transient.`;
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * The agent's Slack toolbelt: an MCP server living in the agentd process,
 * reachable by the session and by nothing else. Every tool is a bridge
 * call carrying the agent's netd-verified identity; no Slack credential
 * exists on this side, and the bridge decides what the agent may address.
 */
export function buildToolbelt(options: ToolbeltOptions): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "thicket",
    version: "0.1.0",
    tools: [
      tool(
        "post_message",
        "Post a message to Slack as this agent. Works only where the agent's app " +
          "already is: a channel it has been added to, or a DM it has with someone. " +
          "channel takes a channel ID (C…/D…); thread_ts replies in a thread.",
        {
          channel: z.string().min(1).describe("channel ID, e.g. C0123456789"),
          text: z.string().min(1).describe("message text (Slack markdown)"),
          thread_ts: z.string().optional().describe("parent message ts, to reply in its thread"),
        },
        async (args) => toToolResult(await postMessage(options, args)),
      ),
      tool(
        "upload_file",
        "Upload a local file to a Slack conversation as this agent. Same reach as " +
          "post_message: the agent's app must already be in the channel or DM.",
        {
          path: z.string().min(1).describe("file path; relative paths resolve against the session cwd"),
          channel: z.string().min(1).describe("channel ID to share the file into"),
          thread_ts: z.string().optional().describe("parent message ts, to share into its thread"),
          comment: z.string().optional().describe("message shown alongside the file"),
        },
        async (args) => toToolResult(await uploadFile(options, args)),
      ),
      tool(
        "read_channel",
        "Read recent messages in a Slack channel or DM the agent's app is in, " +
          "newest first. Use the returned next_cursor to page further back.",
        {
          channel: z.string().min(1).describe("channel ID, e.g. C0123456789"),
          limit: z.number().int().positive().optional().describe("messages per page (default 50, max 200)"),
          oldest: z.string().optional().describe("only messages after this ts"),
          latest: z.string().optional().describe("only messages before this ts"),
          cursor: z.string().optional().describe("next_cursor from a previous page"),
        },
        async (args) => toToolResult(await readBridge(options, "/api/history", args)),
      ),
      tool(
        "read_thread",
        "Read a Slack thread's messages, oldest first, given its channel and the " +
          "parent message's ts.",
        {
          channel: z.string().min(1).describe("channel ID the thread lives in"),
          ts: z.string().min(1).describe("the thread parent's ts"),
          limit: z.number().int().positive().optional().describe("messages per page (default 50, max 200)"),
          cursor: z.string().optional().describe("next_cursor from a previous page"),
        },
        async (args) => toToolResult(await readBridge(options, "/api/replies", args)),
      ),
      tool(
        "search_messages",
        "Search public channels in the Slack workspace. Supports Slack search " +
          "modifiers like in:#channel, from:@user, before:/after: dates. Private " +
          "conversations are not searchable; use read_channel for those.",
        {
          query: z.string().min(1).describe("search query"),
          count: z.number().int().positive().optional().describe("results per page (default 20, max 100)"),
          page: z.number().int().positive().optional().describe("result page, from a previous response"),
        },
        async (args) => toToolResult(await readBridge(options, "/api/search", args)),
      ),
      tool(
        "list_channels",
        "List the workspace's channels: public ones, and private ones the agent's " +
          "app is in. is_member says whether the agent can post or read there.",
        {
          limit: z.number().int().positive().optional().describe("channels per page (default 50, max 200)"),
          cursor: z.string().optional().describe("next_cursor from a previous page"),
          include_archived: z.boolean().optional().describe("include archived channels"),
        },
        async (args) =>
          toToolResult(
            await readBridge(options, "/api/channels", {
              ...args,
              include_archived: args.include_archived === true ? "true" : undefined,
            }),
          ),
      ),
      tool(
        "list_users",
        "List the workspace's people: id, handle, real name, and whether each is a bot.",
        {
          limit: z.number().int().positive().optional().describe("users per page (default 50, max 200)"),
          cursor: z.string().optional().describe("next_cursor from a previous page"),
        },
        async (args) => toToolResult(await readBridge(options, "/api/users", args)),
      ),
    ],
  });
}

/** Tool names for the session's allow-list, fully qualified. */
export const TOOLBELT_ALLOWED_TOOLS = [
  "mcp__thicket__post_message",
  "mcp__thicket__upload_file",
  "mcp__thicket__read_channel",
  "mcp__thicket__read_thread",
  "mcp__thicket__search_messages",
  "mcp__thicket__list_channels",
  "mcp__thicket__list_users",
];
