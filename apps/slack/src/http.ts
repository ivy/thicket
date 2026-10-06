import express from "express";
import type { NextFunction, Request, Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { deriveSessionId } from "@thicket/executor";

import type { BridgeState, InFlightTask } from "./state.js";

/** Header netd stamps with the caller's WhoIs-verified ACL tags. */
export const PEER_TAGS_HEADER = "x-thicket-peer-tags";

export interface FileServerLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface FileServerOptions {
  state: BridgeState;
  /** ACL tag -> agent name, from the roster. */
  agentByTag: Map<string, string>;
  /** Bot token for the agent's Slack app, by agent name. */
  botTokenFor: (agent: string) => string | undefined;
  logger: FileServerLogger;
  /**
   * Every call this surface makes to Slack. Required rather than defaulted:
   * the bridge's way out is netd's socket, and a default would put a direct
   * dial one forgotten argument away.
   */
  fetchImpl: typeof fetch;
}

export function parsePeerTags(value: string | undefined): string[] {
  return value === undefined
    ? []
    : value
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== "");
}

/**
 * Slack error codes that mean "this agent has no business there" — the
 * answer to an authorization question, surfaced as a refusal the agent's
 * model can understand. Everything else non-ok is the bridge's problem
 * (credentials, rate limits, transport) and reads as a gateway error.
 */
const SLACK_REFUSALS = new Set([
  "not_in_channel",
  "channel_not_found",
  "is_archived",
  "restricted_action",
  "cannot_dm_bot",
]);

/** Cap for an agent-supplied upload; Slack's own per-file cap is 1 GB. */
const UPLOAD_LIMIT = "50mb";

/**
 * Reactions per agent per minute. reactions.add is Tier 3 (~50/min);
 * the cap leaves the workspace budget for everything else the bridge
 * does with the same app.
 */
const REACTIONS_PER_MINUTE = 20;

/** Slack emoji names: what fits between the colons. */
const EMOJI_NAME = /^[a-z0-9_+'-]+$/;

/**
 * Read budgets. A channel's history can be arbitrarily long; an agent
 * that wants more pages for its next cursor, not a bigger firehose.
 */
const READ_LIMIT_DEFAULT = 50;
const READ_LIMIT_MAX = 200;
const SEARCH_COUNT_DEFAULT = 20;
const SEARCH_COUNT_MAX = 100;

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(n), max);
}

/** Slack messages, trimmed to what a model can use without drowning. */
function trimMessage(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    ts: String(raw.ts ?? ""),
    ...(typeof raw.thread_ts === "string" ? { thread_ts: raw.thread_ts } : {}),
    ...(typeof raw.user === "string" ? { user: raw.user } : {}),
    ...(typeof raw.bot_id === "string" ? { bot_id: raw.bot_id } : {}),
    ...(typeof raw.subtype === "string" ? { subtype: raw.subtype } : {}),
    text: typeof raw.text === "string" ? raw.text : "",
    ...(typeof raw.reply_count === "number" && raw.reply_count > 0
      ? { reply_count: raw.reply_count }
      : {}),
    ...(Array.isArray(raw.files)
      ? {
          files: (raw.files as Record<string, unknown>[]).map((file) => ({
            id: String(file.id ?? ""),
            name: String(file.name ?? ""),
          })),
        }
      : {}),
  };
}

function nextCursor(body: Record<string, unknown>): Record<string, unknown> {
  const cursor = (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
  return cursor !== undefined && cursor !== "" ? { next_cursor: cursor } : {};
}

/**
 * The bridge's inbound surface: the reverse of the edge it normally uses,
 * so that an agent can read a file a human attached without ever holding a
 * Slack credential.
 *
 * Authorization is the same shape as agentd's — trust the peer-tags header
 * precisely because this is only reachable through netd, which strips
 * client-supplied copies and stamps the WhoIs-verified value. The tag names
 * the agent, and the agent is then part of the lookup: a file belonging to
 * another agent's thread is indistinguishable from one that does not exist.
 */
export function buildFileServer(options: FileServerOptions): express.Express {
  const { state, agentByTag, botTokenFor, logger, fetchImpl } = options;
  const app = express();
  app.disable("x-powered-by");

  const identify = (req: Request, res: Response, next: NextFunction): void => {
    const tags = parsePeerTags(req.header(PEER_TAGS_HEADER));
    const agent = tags.map((tag) => agentByTag.get(tag)).find((name) => name !== undefined);
    if (agent === undefined) {
      logger.warn("rejected unauthorized peer", { peerTags: tags, path: req.path });
      res.status(403).json({
        error:
          tags.length === 0
            ? "peer identity missing: requests must arrive through netd"
            : `peer not authorized: tags [${tags.join(", ")}] name no agent in this bridge`,
      });
      return;
    }
    res.locals.agent = agent;
    next();
  };

  /**
   * A Web API call on the agent's own bot token. Whether the agent may
   * address a channel is answered by Slack's membership state for that
   * app — bridge-held ground truth the agent cannot assert its way past.
   */
  const slackCall = async (
    agent: string,
    method: string,
    params: Record<string, string>,
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> => {
    const token = botTokenFor(agent);
    if (token === undefined) {
      return { ok: false, error: "no credential for this agent" };
    }
    logger.info("slack call", {
      slack: {
        method,
        agent,
        ...Object.fromEntries(
          Object.entries(params).map(([key, value]) =>
            key === "text" || key === "initial_comment" ? ["chars", value.length] : [key, value],
          ),
        ),
      },
    });
    const response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        authorization: `Bearer ${token}`,
      },
      body: new URLSearchParams(params).toString(),
    });
    const body = (await response.json()) as { ok?: boolean; error?: string };
    if (body.ok !== true) {
      return { ok: false, error: String(body.error ?? `slack returned ${response.status}`) };
    }
    return { ok: true, body: body as Record<string, unknown> };
  };

  /**
   * The open turn this agent is answering in that thread, if any. Only
   * turns the bridge itself started from a Slack message are here, which
   * is exactly the distinction that matters: a routine or a one-shot has
   * no turn, no stream, and no other way to reach the thread it reports
   * into.
   */
  const turnIn = (agent: string, channel: string, threadTs: string): InFlightTask | undefined =>
    state
      .allTasks()
      .find((task) => task.agent === agent && task.channel === channel && task.threadTs === threadTs);

  /**
   * A refusal the agent can act on. `redundant` marks the kind that is not
   * a permission problem at all: the thing asked for is already happening,
   * so the step is dropped from the timeline rather than shown as a failure.
   */
  const refuse = (
    res: Response,
    agent: string,
    action: string,
    error: string,
    redundant = false,
  ): void => {
    logger.warn("refused agent slack action", { agent, action, error });
    res.status(403).json({ error, ...(redundant ? { redundant: true } : {}) });
  };

  const refuseOrFail = (res: Response, agent: string, action: string, error: string): void => {
    if (SLACK_REFUSALS.has(error)) {
      logger.warn("refused agent slack action", { agent, action, error });
      res.status(403).json({ error });
    } else {
      logger.warn("agent slack action failed", { agent, action, error });
      res.status(502).json({ error });
    }
  };

  app.post("/api/messages", identify, express.json(), (req, res) => {
    const agent = res.locals.agent as string;
    const body = req.body as { channel?: unknown; text?: unknown; thread_ts?: unknown };
    if (typeof body.channel !== "string" || body.channel === "") {
      res.status(400).json({ error: "channel is required" });
      return;
    }
    if (typeof body.text !== "string" || body.text === "") {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const threadTs = typeof body.thread_ts === "string" ? body.thread_ts : undefined;
    if (threadTs !== undefined && turnIn(agent, body.channel, threadTs) !== undefined) {
      refuse(
        res,
        agent,
        "post",
        "you are answering in that thread right now, and your reply is delivered " +
          "there when the turn ends. Say it in the reply instead of posting it. " +
          "post_message is for a conversation you are not answering in, and for " +
          "scheduled runs, whose reply text goes nowhere.",
        true,
      );
      return;
    }
    void (async () => {
      const result = await slackCall(agent, "chat.postMessage", {
        channel: body.channel as string,
        text: body.text as string,
        ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
      });
      if (!result.ok) {
        refuseOrFail(res, agent, "post", result.error);
        return;
      }
      res.status(200).json({ ok: true, channel: result.body.channel, ts: result.body.ts });
    })().catch((err: unknown) => {
      logger.warn("agent post failed", { agent, err: String(err) });
      if (!res.headersSent) {
        res.status(502).json({ error: "slack unreachable" });
      }
    });
  });

  app.post(
    "/api/files",
    identify,
    express.raw({ type: () => true, limit: UPLOAD_LIMIT }),
    (req, res) => {
      const agent = res.locals.agent as string;
      const channel = String(req.query.channel ?? "");
      const filename = String(req.query.filename ?? "");
      const threadTs = typeof req.query.thread_ts === "string" ? req.query.thread_ts : undefined;
      const comment =
        typeof req.query.comment === "string" && req.query.comment !== ""
          ? req.query.comment
          : undefined;
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (channel === "" || filename === "") {
        res.status(400).json({ error: "channel and filename are required" });
        return;
      }
      if (bytes.length === 0) {
        res.status(400).json({ error: "empty body: send the file bytes" });
        return;
      }
      void (async () => {
        // The external upload flow; files.upload itself is retired.
        const ticket = await slackCall(agent, "files.getUploadURLExternal", {
          filename,
          length: String(bytes.length),
        });
        if (!ticket.ok) {
          refuseOrFail(res, agent, "upload", ticket.error);
          return;
        }
        const put = await fetchImpl(String(ticket.body.upload_url), {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: bytes,
        });
        if (!put.ok) {
          logger.warn("upload bytes rejected", { agent, filename, status: put.status });
          res.status(502).json({ error: `upload returned ${put.status}` });
          return;
        }
        const done = await slackCall(agent, "files.completeUploadExternal", {
          files: JSON.stringify([{ id: String(ticket.body.file_id), title: filename }]),
          channel_id: channel,
          ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
          ...(comment === undefined ? {} : { initial_comment: comment }),
        });
        if (!done.ok) {
          refuseOrFail(res, agent, "upload", done.error);
          return;
        }
        res.status(200).json({ ok: true, file_id: ticket.body.file_id, channel });
      })().catch((err: unknown) => {
        logger.warn("agent upload failed", { agent, filename, err: String(err) });
        if (!res.headersSent) {
          res.status(502).json({ error: "slack unreachable" });
        }
      });
    },
  );

  // Sliding-window reaction budget per agent.
  const reactionTimes = new Map<string, number[]>();
  const underReactionBudget = (agent: string): boolean => {
    const now = Date.now();
    const times = (reactionTimes.get(agent) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= REACTIONS_PER_MINUTE) {
      reactionTimes.set(agent, times);
      return false;
    }
    times.push(now);
    reactionTimes.set(agent, times);
    return true;
  };

  /**
   * A reaction goes only on a message in a thread this agent is currently
   * answering. The agent names a ts and an emoji, nothing more: the
   * channel comes from the bridge's own in-flight task records, and
   * membership is checked against Slack's record of that thread. A write
   * route widens the trust edge 017 opened; this constraint is the whole
   * design.
   */
  app.post("/api/reactions", identify, express.json(), (req, res) => {
    const agent = res.locals.agent as string;
    const body = req.body as { message_ts?: unknown; emoji?: unknown };
    const messageTs = typeof body.message_ts === "string" ? body.message_ts : "";
    const emoji =
      typeof body.emoji === "string" ? body.emoji.replace(/^:|:$/g, "").toLowerCase() : "";
    if (emoji === "") {
      res.status(400).json({ error: "emoji is required" });
      return;
    }
    if (!EMOJI_NAME.test(emoji)) {
      res.status(400).json({ error: `not an emoji name: ${emoji}` });
      return;
    }
    if (!underReactionBudget(agent)) {
      logger.warn("reaction budget exhausted", { agent });
      res.status(429).json({ error: "reaction budget exhausted; try later" });
      return;
    }
    void (async () => {
      // Candidate threads: the ones this agent has an open turn in.
      const agentTasks = state.allTasks().filter((task) => task.agent === agent);
      if (messageTs === "") {
        // No ts named: the message being answered — the triggering
        // message of the most recently opened turn, from the bridge's
        // own record. The agent never had to know a ts at all.
        const latest = [...agentTasks].reverse().find((task) => task.messageTs != null);
        if (latest?.messageTs == null) {
          res.status(403).json({
            error: "no open turn to react from; pass message_ts for an earlier thread message",
          });
          return;
        }
        const added = await slackCall(agent, "reactions.add", {
          channel: latest.channel,
          timestamp: latest.messageTs,
          name: emoji,
        });
        if (!added.ok && added.error !== "already_reacted") {
          refuseOrFail(res, agent, "react", added.error);
          return;
        }
        res.status(200).json({ ok: true, message_ts: latest.messageTs });
        return;
      }
      const threads = new Map<string, { channel: string; threadTs: string }>();
      for (const task of agentTasks) {
        threads.set(`${task.channel}:${task.threadTs}`, {
          channel: task.channel,
          threadTs: task.threadTs,
        });
      }
      let target: { channel: string } | undefined;
      for (const { channel, threadTs } of threads.values()) {
        if (messageTs === threadTs) {
          target = { channel };
          break;
        }
        const result = await slackCall(agent, "conversations.replies", {
          channel,
          ts: threadTs,
          limit: "200",
        });
        if (!result.ok) {
          continue; // an unreadable candidate is simply not a match
        }
        const messages = (result.body.messages ?? []) as { ts?: string }[];
        if (messages.some((message) => message.ts === messageTs)) {
          target = { channel };
          break;
        }
      }
      if (target === undefined) {
        logger.warn("refused reaction outside the agent's open threads", { agent, messageTs });
        res.status(403).json({
          error: "message is not in a thread you are currently answering",
        });
        return;
      }
      const added = await slackCall(agent, "reactions.add", {
        channel: target.channel,
        timestamp: messageTs,
        name: emoji,
      });
      if (!added.ok) {
        if (added.error === "already_reacted") {
          res.status(200).json({ ok: true, already: true });
          return;
        }
        refuseOrFail(res, agent, "react", added.error);
        return;
      }
      res.status(200).json({ ok: true });
    })().catch((err: unknown) => {
      logger.warn("agent reaction failed", { agent, err: String(err) });
      if (!res.headersSent) {
        res.status(502).json({ error: "slack unreachable" });
      }
    });
  });

  /**
   * Where a session's current turn is happening. The agent names its
   * session (a contextId its toolbelt was built with, not something the
   * model typed) and the bridge answers from its own in-flight records:
   * the thread this agent is answering right now whose context that is.
   * Nothing else resolves — a one-shot cannot be aimed at a thread the
   * agent is not in the middle of.
   */
  app.get("/api/origin", identify, (req, res) => {
    const agent = res.locals.agent as string;
    const contextId = typeof req.query.context_id === "string" ? req.query.context_id : "";
    if (contextId === "") {
      res.status(400).json({ error: "context_id is required" });
      return;
    }
    const open = state
      .allTasks()
      .filter((task) => task.agent === agent)
      .find(
        (task) =>
          (state.contextFor(task.channel, task.threadTs) ??
            deriveSessionId(task.channel, task.threadTs)) === contextId,
      );
    if (open === undefined) {
      res.status(403).json({ error: "no open turn in that conversation" });
      return;
    }
    res.status(200).json({
      ok: true,
      channel: open.channel,
      thread_ts: open.threadTs,
      context_id: contextId,
    });
  });

  /**
   * The read routes. Entitlement is the same everywhere: the call runs on
   * the agent's own bot token, so what the agent may read is what its app
   * can already see — membership for history, member-only listings for
   * private channels, public-only search. The tool argument is never the
   * authority.
   */
  const readRoute = (
    path: string,
    action: string,
    handle: (
      req: Request,
      agent: string,
    ) =>
      | { error: string }
      | { refused: string }
      | { method: string; params: Record<string, string>; render: (body: Record<string, unknown>) => Record<string, unknown> },
  ): void => {
    app.get(path, identify, (req, res) => {
      const agent = res.locals.agent as string;
      const plan = handle(req, agent);
      if ("error" in plan) {
        res.status(400).json({ error: plan.error });
        return;
      }
      if ("refused" in plan) {
        refuse(res, agent, action, plan.refused, true);
        return;
      }
      void (async () => {
        const result = await slackCall(agent, plan.method, plan.params);
        if (!result.ok) {
          refuseOrFail(res, agent, action, result.error);
          return;
        }
        res.status(200).json({ ok: true, ...plan.render(result.body) });
      })().catch((err: unknown) => {
        logger.warn("agent read failed", { agent, action, err: String(err) });
        if (!res.headersSent) {
          res.status(502).json({ error: "slack unreachable" });
        }
      });
    });
  };

  readRoute("/api/history", "history", (req) => {
    const channel = String(req.query.channel ?? "");
    if (channel === "") {
      return { error: "channel is required" };
    }
    return {
      method: "conversations.history",
      params: {
        channel,
        limit: String(clampLimit(req.query.limit, READ_LIMIT_DEFAULT, READ_LIMIT_MAX)),
        ...(typeof req.query.oldest === "string" ? { oldest: req.query.oldest } : {}),
        ...(typeof req.query.latest === "string" ? { latest: req.query.latest } : {}),
        ...(typeof req.query.cursor === "string" ? { cursor: req.query.cursor } : {}),
      },
      render: (body) => ({
        messages: ((body.messages ?? []) as Record<string, unknown>[]).map(trimMessage),
        ...(body.has_more === true ? { has_more: true } : {}),
        ...nextCursor(body),
      }),
    };
  });

  readRoute("/api/replies", "replies", (req, agent) => {
    const channel = String(req.query.channel ?? "");
    const ts = String(req.query.ts ?? "");
    if (channel === "" || ts === "") {
      return { error: "channel and ts are required" };
    }
    // A turn that did not open its thread was given every message since it
    // did; a turn whose own message is the thread's root has nothing above
    // it. Either way the agent already holds what a read would return. What
    // is left — being mentioned into a thread that was already running — is
    // the one case where the messages above were never delivered.
    const turn = turnIn(agent, channel, ts);
    if (turn !== undefined && (turn.opening !== true || turn.messageTs === ts)) {
      return {
        refused:
          "you already have this thread: its messages reached you as they were " +
          "sent. read_thread is for another thread, or for one you have just " +
          "been brought into, where what was said before you arrived is new to you.",
      };
    }
    return {
      method: "conversations.replies",
      params: {
        channel,
        ts,
        limit: String(clampLimit(req.query.limit, READ_LIMIT_DEFAULT, READ_LIMIT_MAX)),
        ...(typeof req.query.cursor === "string" ? { cursor: req.query.cursor } : {}),
      },
      render: (body) => ({
        messages: ((body.messages ?? []) as Record<string, unknown>[]).map(trimMessage),
        ...(body.has_more === true ? { has_more: true } : {}),
        ...nextCursor(body),
      }),
    };
  });

  readRoute("/api/search", "search", (req) => {
    const query = String(req.query.query ?? "");
    if (query === "") {
      return { error: "query is required" };
    }
    return {
      method: "search.messages",
      params: {
        query,
        count: String(clampLimit(req.query.count, SEARCH_COUNT_DEFAULT, SEARCH_COUNT_MAX)),
        ...(typeof req.query.page === "string" ? { page: req.query.page } : {}),
      },
      render: (body) => {
        const messages = (body.messages ?? {}) as {
          total?: number;
          paging?: { page?: number; pages?: number };
          matches?: Record<string, unknown>[];
        };
        return {
          total: messages.total ?? 0,
          ...(messages.paging !== undefined
            ? { page: messages.paging.page, pages: messages.paging.pages }
            : {}),
          matches: (messages.matches ?? []).map((raw) => ({
            ts: String(raw.ts ?? ""),
            channel: {
              id: String((raw.channel as { id?: string } | undefined)?.id ?? ""),
              name: String((raw.channel as { name?: string } | undefined)?.name ?? ""),
            },
            ...(typeof raw.user === "string" ? { user: raw.user } : {}),
            text: typeof raw.text === "string" ? raw.text : "",
            ...(typeof raw.permalink === "string" ? { permalink: raw.permalink } : {}),
          })),
        };
      },
    };
  });

  readRoute("/api/channels", "channels", (req) => ({
    method: "conversations.list",
    params: {
      // Private channels appear only when the app is a member; that scoping
      // is Slack's, not the argument's.
      types: "public_channel,private_channel",
      exclude_archived: String(req.query.include_archived !== "true"),
      limit: String(clampLimit(req.query.limit, READ_LIMIT_DEFAULT, READ_LIMIT_MAX)),
      ...(typeof req.query.cursor === "string" ? { cursor: req.query.cursor } : {}),
    },
    render: (body) => ({
      channels: ((body.channels ?? []) as Record<string, unknown>[]).map((raw) => ({
        id: String(raw.id ?? ""),
        name: String(raw.name ?? ""),
        is_private: raw.is_private === true,
        is_member: raw.is_member === true,
        ...(raw.is_archived === true ? { is_archived: true } : {}),
        ...(typeof (raw.topic as { value?: string } | undefined)?.value === "string" &&
        (raw.topic as { value: string }).value !== ""
          ? { topic: (raw.topic as { value: string }).value }
          : {}),
      })),
      ...nextCursor(body),
    }),
  }));

  readRoute("/api/users", "users", (req) => ({
    method: "users.list",
    params: {
      limit: String(clampLimit(req.query.limit, READ_LIMIT_DEFAULT, READ_LIMIT_MAX)),
      ...(typeof req.query.cursor === "string" ? { cursor: req.query.cursor } : {}),
    },
    render: (body) => ({
      users: ((body.members ?? []) as Record<string, unknown>[])
        .filter((raw) => raw.deleted !== true)
        .map((raw) => ({
          id: String(raw.id ?? ""),
          name: String(raw.name ?? ""),
          ...(typeof (raw.profile as { real_name?: string } | undefined)?.real_name === "string"
            ? { real_name: (raw.profile as { real_name: string }).real_name }
            : {}),
          ...(raw.is_bot === true ? { is_bot: true } : {}),
        })),
      ...nextCursor(body),
    }),
  }));

  app.get("/files/:fileId", identify, (req, res) => {
    const agent = res.locals.agent as string;
    const fileId = String(req.params.fileId);
    const file = state.fileFor(agent, fileId);
    if (file === undefined) {
      logger.warn("file not available to this agent", { agent, fileId });
      res.status(404).json({ error: "no such file" });
      return;
    }
    const token = botTokenFor(agent);
    if (token === undefined) {
      res.status(500).json({ error: "no credential for this agent" });
      return;
    }
    void (async () => {
      try {
        const upstream = await fetchImpl(file.url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!upstream.ok || upstream.body === null) {
          logger.warn("slack refused the download", {
            agent,
            fileId,
            status: upstream.status,
          });
          res.status(502).json({ error: `slack returned ${upstream.status}` });
          return;
        }
        res.status(200);
        res.setHeader("content-type", file.mimetype);
        // The name is echoed for the fetcher's convenience only; it is
        // attacker-controlled and must be sanitized before it becomes a path.
        res.setHeader(
          "content-disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        );
        const length = upstream.headers.get("content-length");
        if (length !== null) {
          res.setHeader("content-length", length);
        }
        logger.info("serving file", { agent, fileId, size: file.size });
        // Piped, never buffered: a 1 GB upload costs a socket, not a heap.
        await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), res);
      } catch (err) {
        logger.warn("file download failed", { agent, fileId, err: String(err) });
        if (!res.headersSent) {
          res.status(502).json({ error: "download failed" });
        } else {
          // Mid-stream: the only honest signal left is an abrupt close, so
          // the fetcher sees a truncated body rather than a silent short read.
          res.destroy();
        }
      }
    })();
  });

  return app;
}
