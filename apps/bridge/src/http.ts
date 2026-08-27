import express from "express";
import type { NextFunction, Request, Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { BridgeState } from "./state.js";

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
  fetchImpl?: typeof fetch;
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
  const { state, agentByTag, botTokenFor, logger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
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
    handle: (req: Request) => { error: string } | { method: string; params: Record<string, string>; render: (body: Record<string, unknown>) => Record<string, unknown> },
  ): void => {
    app.get(path, identify, (req, res) => {
      const agent = res.locals.agent as string;
      const plan = handle(req);
      if ("error" in plan) {
        res.status(400).json({ error: plan.error });
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

  readRoute("/api/replies", "replies", (req) => {
    const channel = String(req.query.channel ?? "");
    const ts = String(req.query.ts ?? "");
    if (channel === "" || ts === "") {
      return { error: "channel and ts are required" };
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
