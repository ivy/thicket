import express from "express";
import type { NextFunction, Request, Response } from "express";

import type { A2ARequestHandler } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";

import { A2A_PATH } from "@thicket/roster";

import type { Logger } from "./logger.js";

/** Header netd stamps with the caller's WhoIs-verified ACL tags. */
export const PEER_TAGS_HEADER = "x-thicket-peer-tags";

/**
 * Header a same-account caller stamps when it connects to agentd's socket
 * directly instead of through netd — `thicket send`, on this host, as
 * this account. Its value is the caller's unix user name. netd discards
 * every inbound X-Thicket-* header, so the only way this one can arrive
 * is over the socket itself.
 */
export const LOCAL_USER_HEADER = "x-thicket-local-user";

export interface ServerOptions {
  handler: A2ARequestHandler;
  allowedPeerTags: string[];
  /**
   * The unix user agentd runs as. A request carrying that name in
   * {@link LOCAL_USER_HEADER} is admitted without peer tags: the socket
   * is mode 0600, so only this account (and root) can have opened it, and
   * the name is checked so a socket someone widened by hand cannot admit
   * a neighbour who merely asserts it. Absent means no local caller is
   * admitted at all.
   */
  localUser?: string;
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
 * an allow-listed peer tag, or the account's own name on the local-user
 * header from a caller that opened the socket itself.
 */
export function buildServer(options: ServerOptions): express.Express {
  const { handler, allowedPeerTags, localUser, logger } = options;
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
    const local = req.header(LOCAL_USER_HEADER);
    if (local !== undefined && localUser !== undefined && local === localUser) {
      next();
      return;
    }
    logger.warn("rejected unauthorized peer", {
      peerTags: tags,
      ...(local === undefined ? {} : { localUser: local }),
      path: req.path,
    });
    // A2A-shaped rejection: a JSON-RPC error envelope, not a bare 500.
    res.status(403).json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message:
          local !== undefined
            ? `local caller not authorized: ${local} is not the account this agent runs as`
            : tags.length === 0
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
