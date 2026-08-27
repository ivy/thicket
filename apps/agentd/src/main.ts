import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { DefaultRequestHandler } from "@a2a-js/sdk/server";

import { parseRoster, toAgentCard } from "@thicket/roster";
import { AttachmentStore, ClaudeAgentExecutor, SessionManager } from "@thicket/executor";

import { defaultConfigPath, loadConfig, sessionEnv, type AgentdConfig } from "./config.js";
import { egressFetch } from "./egress.js";
import { pruneAttachments } from "./attachments-cache.js";
import { listen, resolveListenTarget } from "./listen.js";
import { createLogger, type Logger } from "./logger.js";
import { buildServer } from "./server.js";
import { SqliteTaskStore } from "./store/sqlite-task-store.js";

const SHUTDOWN_TIMEOUT_MS = 30_000;
const ATTACHMENT_PRUNE_INTERVAL_MS = 6 * 60 * 60_000;

export async function run(
  configPath: string = process.env.THICKET_AGENTD_CONFIG ?? defaultConfigPath(),
  logger: Logger = createLogger(),
): Promise<void> {
  const config: AgentdConfig = loadConfig(configPath);
  const roster = parseRoster(readFileSync(config.agentsFile, "utf8"));
  const entry = roster.agents[config.agent];
  if (entry === undefined) {
    throw new Error(`agent ${config.agent} not found in ${config.agentsFile}`);
  }
  const card = toAgentCard(config.agent, entry, {
    tailnetDomain: config.tailnetDomain,
  });

  const store = new SqliteTaskStore(config.dbPath);
  const reconciled = store.failUnfinished(
    "agentd restarted; the previous process and its running turn are gone. Send the message again.",
  );
  if (reconciled > 0) {
    logger.warn("failed unfinished tasks from previous process", { count: reconciled });
  }

  const sessions = new SessionManager({
    harness: entry.harness,
    env: sessionEnv(config),
    maxSessions: config.maxSessions,
    onWarning: (msg) => logger.warn(msg),
  });
  // Refusing attachments is a roster policy, so the store is simply absent
  // for an agent that does not take them: nothing to fetch, nothing to
  // configure wrongly.
  const attachments =
    entry.harness.attachments === "accept"
      ? new AttachmentStore({
          dir: config.attachmentsDir,
          fetchImpl: egressFetch(config.egressSocket),
        })
      : undefined;
  const executor = new ClaudeAgentExecutor({
    sessions,
    onWarning: (msg) => logger.warn(msg),
    ...(attachments === undefined ? {} : { attachments }),
  });
  const handler = new DefaultRequestHandler(card, store, executor);

  const app = buildServer({
    handler,
    allowedPeerTags: config.allowedPeerTags,
    logger,
  });
  const server = createServer(app);
  const target = resolveListenTarget(process.env, process.pid, config.socketPath);
  await listen(server, target);
  logger.info("agentd listening", {
    agent: config.agent,
    target: target.kind === "fd" ? `fd:${target.fd}` : target.path,
  });

  const pruneTimer = setInterval(() => {
    void pruneAttachments(config.attachmentsDir).then((dropped) => {
      if (dropped > 0) {
        logger.info("pruned attachment cache", { count: dropped });
      }
    });
  }, ATTACHMENT_PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("shutting down", { signal });
    const deadline = setTimeout(() => {
      logger.error("shutdown timeout; exiting");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    deadline.unref();
    server.close(() => {
      void sessions.shutdown().then(() => {
        store.close();
        logger.info("shutdown complete");
        process.exit(0);
      });
    });
    // close() waits for in-flight requests; also stop keep-alive idlers.
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
