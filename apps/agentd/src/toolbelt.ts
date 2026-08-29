import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { parseCron } from "./cron.js";
import type { RoutineOrigin, RoutineStore } from "./store/routines.js";

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
  /**
   * The session this toolbelt serves. Baked in at construction, never
   * supplied by the model: it is how a one-shot learns its origin thread
   * without the agent being able to name an arbitrary one.
   */
  contextId?: string;
  /** When present, the routine CRUD tools are offered (task 022). */
  routines?: RoutineStore;
  /** Clock for "is that fire time still ahead of us"; injectable for tests. */
  now?: () => number;
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

/**
 * Where the session's current turn is happening, from the bridge's own
 * record of the thread it is answering. The bridge is the authority; the
 * agent only says which session it is asking for.
 */
export async function resolveOrigin(options: ToolbeltOptions): Promise<RoutineOrigin | { error: string }> {
  if (options.contextId === undefined) {
    return { error: "this session has no conversation to schedule from" };
  }
  const outcome = await readBridge(options, "/api/origin", { context_id: options.contextId });
  if (outcome.outcome !== "ok") {
    return { error: outcome.error };
  }
  const { channel, thread_ts, context_id } = outcome.detail;
  if (typeof channel !== "string" || typeof thread_ts !== "string" || typeof context_id !== "string") {
    return { error: "bridge returned no origin" };
  }
  return { channel, threadTs: thread_ts, contextId: context_id };
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

function ok(detail: Record<string, unknown>): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...detail }) }] };
}

function toolError(text: string): {
  isError: true;
  content: { type: "text"; text: string }[];
} {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Routine CRUD, so the agent manages its own standing work
 * conversationally. Schedules are five-field cron evaluated in this
 * host's local time zone; minutes that pass while the machine is asleep
 * are skipped, not replayed.
 */
export function routineTools(options: ToolbeltOptions, store: RoutineStore) {
  const now = options.now ?? (() => Date.now());
  const validateCron = (cron: string): string | undefined =>
    parseCron(cron) === undefined
      ? `not a valid cron expression: "${cron}". Five fields — minute hour ` +
        `day-of-month month day-of-week — with *, numbers, ranges, lists, ` +
        `and steps (e.g. "0 9 * * 1-5" for weekday mornings at 09:00 local time).`
      : undefined;
  return [
    tool(
      "routine_create",
      "Create a scheduled routine: a prompt this agent runs on a cron " +
        "schedule (host local time), in its own persistent conversation. A " +
        "routine run talks to no one — anything worth saying must go through " +
        "post_message, and saying nothing is the normal outcome. Five " +
        "consecutive failing runs disable the routine automatically.",
      {
        name: z.string().min(1).describe("short human name, e.g. changelog-watch"),
        cron: z.string().min(1).describe("five-field cron, e.g. '0 9 * * *' for 09:00 daily"),
        prompt: z.string().min(1).describe("what to do each run, including where to post"),
      },
      async (args) => {
        const invalid = validateCron(args.cron);
        if (invalid !== undefined) {
          return toolError(invalid);
        }
        const routine = store.create(args);
        return ok({ routine: { id: routine.id, name: routine.name, cron: routine.cron } });
      },
    ),
    tool(
      "schedule_once",
      "Schedule a one-off prompt for later, from the conversation you are in " +
        "right now: at the given time this agent comes back to this very " +
        "thread — same session, so it still knows what was being discussed — " +
        "runs the prompt, and reports the result here with post_message. Use " +
        "it for \"check on this tomorrow at 9\", \"remind me in an hour\". " +
        "Convert the person's words to a time yourself; the host's local " +
        "time zone applies to an `at` without an offset. A fire time that " +
        "passes while the agent is down fires when it comes back, once. It " +
        "appears in routine_list and routine_delete cancels it.",
      {
        at: z
          .string()
          .min(1)
          .describe("when to fire, ISO 8601 with a time, e.g. 2026-08-29T09:00 (local) or ...T09:00:00-07:00"),
        prompt: z.string().min(1).describe("what to do then, written for your future self"),
        name: z.string().min(1).optional().describe("short label; defaults to the prompt's first words"),
      },
      async (args) => {
        const atMs = Date.parse(args.at);
        if (!Number.isFinite(atMs)) {
          return toolError(
            `not a time I can parse: "${args.at}". Give ISO 8601 with a time, ` +
              `e.g. 2026-08-29T09:00 for 09:00 local or 2026-08-29T09:00:00-07:00.`,
          );
        }
        if (atMs <= now()) {
          return toolError(
            `${args.at} is already past (it is ${new Date(now()).toISOString()} now). ` +
              `If they meant right away, just do it; otherwise pick a time ahead.`,
          );
        }
        const origin = await resolveOrigin(options);
        if ("error" in origin) {
          return toolError(
            `Cannot schedule from here: ${origin.error}. One-shots come back to the ` +
              `Slack thread they were asked in, so ask for this from a Slack conversation.`,
          );
        }
        const name = args.name ?? args.prompt.replace(/\s+/g, " ").trim().slice(0, 40);
        const routine = store.createOneShot({ name, atMs, prompt: args.prompt, origin });
        return ok({
          scheduled: {
            id: routine.id,
            name: routine.name,
            at: new Date(atMs).toISOString(),
            channel: origin.channel,
            thread_ts: origin.threadTs,
          },
        });
      },
    ),
    tool(
      "routine_list",
      "List this agent's scheduled work — cron routines and one-shots: id, " +
        "name, schedule or fire time, enabled, failure count, and the last " +
        "run's outcome. A one-shot with `fired` set has already happened.",
      {},
      async () =>
        ok({
          routines: store.list().map((routine) => ({
            id: routine.id,
            name: routine.name,
            kind: routine.kind,
            ...(routine.kind === "cron"
              ? { cron: routine.cron }
              : {
                  at: routine.atMs === null ? null : new Date(routine.atMs).toISOString(),
                  fired: routine.firedMs === null ? null : new Date(routine.firedMs).toISOString(),
                  ...(routine.origin === null
                    ? {}
                    : { channel: routine.origin.channel, thread_ts: routine.origin.threadTs }),
                }),
            enabled: routine.enabled,
            consecutive_failures: routine.consecutiveFailures,
            last_run: routine.lastRunMs === null ? null : new Date(routine.lastRunMs).toISOString(),
            last_outcome: routine.lastOutcome,
          })),
        }),
    ),
    tool(
      "routine_update",
      "Update a routine's name, schedule, prompt, or enabled flag. " +
        "Re-enabling a disabled routine resets its failure count.",
      {
        id: z.string().min(1).describe("routine id, from routine_list"),
        name: z.string().min(1).optional(),
        cron: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
      },
      async (args) => {
        const { id, ...patch } = args;
        const existing = store.get(id);
        if (existing === undefined) {
          return toolError(`no routine with id ${id}; routine_list shows what exists`);
        }
        if (args.cron !== undefined) {
          if (existing.kind === "at") {
            return toolError(
              `${id} is a one-shot, not a cron routine; to change its time, delete it and schedule_once again`,
            );
          }
          const invalid = validateCron(args.cron);
          if (invalid !== undefined) {
            return toolError(invalid);
          }
        }
        store.update(id, patch);
        return ok({ id });
      },
    ),
    tool(
      "routine_delete",
      "Delete a routine or cancel an unfired one-shot, permanently. To pause " +
        "a routine instead, routine_update with enabled: false.",
      {
        id: z.string().min(1).describe("routine id, from routine_list"),
      },
      async (args) => {
        if (!store.remove(args.id)) {
          return toolError(`no routine with id ${args.id}; routine_list shows what exists`);
        }
        return ok({ deleted: args.id });
      },
    ),
  ];
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
        "react",
        "Put an emoji reaction on the message you are currently answering — " +
          "omit message_ts and the bridge resolves it for you. Pass message_ts " +
          "only to react to an earlier message in the same thread. Cheaper " +
          "than a reply and lands on their message. Use it situationally and " +
          "vary the emoji; the same reaction every time reads as a status " +
          "light, not a presence.",
        {
          emoji: z.string().min(1).describe("emoji name without colons, e.g. white_check_mark"),
          message_ts: z
            .string()
            .optional()
            .describe("ts of an earlier thread message; omit for the message being answered"),
        },
        async (args) =>
          toToolResult(
            await callBridge(options, "/api/reactions", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(args),
            }),
          ),
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
      ...(options.routines === undefined ? [] : routineTools(options, options.routines)),
    ],
  });
}

/** Tool names for the session's allow-list, fully qualified. */
export const TOOLBELT_ALLOWED_TOOLS = [
  "mcp__thicket__post_message",
  "mcp__thicket__upload_file",
  "mcp__thicket__react",
  "mcp__thicket__read_channel",
  "mcp__thicket__read_thread",
  "mcp__thicket__search_messages",
  "mcp__thicket__list_channels",
  "mcp__thicket__list_users",
  "mcp__thicket__schedule_once",
  "mcp__thicket__routine_create",
  "mcp__thicket__routine_list",
  "mcp__thicket__routine_update",
  "mcp__thicket__routine_delete",
];
