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
