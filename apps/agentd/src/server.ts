import express from "express";
import type { NextFunction, Request, Response } from "express";

import type { A2ARequestHandler } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";

import { A2A_PATH } from "@thicket/roster";

import type { Logger } from "./logger.js";

/** Header netd stamps with the caller's WhoIs-verified ACL tags. */
export const PEER_TAGS_HEADER = "x-thicket-peer-tags";

export interface ServerOptions {
  handler: A2ARequestHandler;
  allowedPeerTags: string[];
  logger: Logger;
}

export function parsePeerTags(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

/**
 * Builds the agentd HTTP app.
 *
 * Authorization trusts the peer-tags header precisely because agentd is
 * only reachable through netd, which strips client-supplied copies and
 * stamps the WhoIs-verified value. The agent card stays readable without
 * authorization — it is discovery data — while every A2A method requires
 * an allow-listed peer tag.
 */
export function buildServer(options: ServerOptions): express.Express {
  const { handler, allowedPeerTags, logger } = options;
  const allowed = new Set(allowedPeerTags);
  const app = express();
  app.disable("x-powered-by");

  app.use(
    "/.well-known/agent-card.json",
    agentCardHandler({ agentCardProvider: handler }),
  );

  const authorize = (req: Request, res: Response, next: NextFunction): void => {
    const tags = parsePeerTags(req.header(PEER_TAGS_HEADER));
    if (tags.some((tag) => allowed.has(tag))) {
      next();
      return;
    }
    logger.warn("rejected unauthorized peer", {
      peerTags: tags,
      path: req.path,
    });
    // A2A-shaped rejection: a JSON-RPC error envelope, not a bare 500.
    res.status(403).json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message:
          tags.length === 0
            ? "peer identity missing: requests must arrive through netd"
            : `peer not authorized: tags [${tags.join(", ")}] are not in this agent's allow-list`,
      },
    });
  };

  app.use(
    A2A_PATH,
    authorize,
    express.json({ limit: "10mb" }),
    jsonRpcHandler({
      requestHandler: handler,
      // Authorization happened above; all allowed peers share one task
      // scope (a thicket agent is single-tenant), so the store is not
      // partitioned per caller.
      userBuilder: UserBuilder.noAuthentication,
    }),
  );

  return app;
}
