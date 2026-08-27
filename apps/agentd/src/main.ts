import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

import { Role, TaskState } from "@a2a-js/sdk";
import type { Message, Task } from "@a2a-js/sdk";
import { DefaultRequestHandler, ServerCallContext } from "@a2a-js/sdk/server";

import { parseRoster, toAgentCard } from "@thicket/roster";
import {
  AttachmentStore,
  ClaudeAgentExecutor,
  deriveSessionId,
  META_TRIGGER,
  SessionManager,
} from "@thicket/executor";

import { defaultConfigPath, loadConfig, sessionEnv, type AgentdConfig } from "./config.js";
import { egressFetch } from "./egress.js";
import { pruneAttachments } from "./attachments-cache.js";
import { listen, resolveListenTarget } from "./listen.js";
import { buildToolbelt, TOOLBELT_ALLOWED_TOOLS } from "./toolbelt.js";
import { createLogger, type Logger } from "./logger.js";
import { buildServer } from "./server.js";
import { SqliteTaskStore } from "./store/sqlite-task-store.js";
import { JournalStore } from "./store/journal.js";
import { RoutineStore } from "./store/routines.js";
import { RoutineRunner, type RoutineTurnResult } from "./routines.js";

const SHUTDOWN_TIMEOUT_MS = 30_000;
const ATTACHMENT_PRUNE_INTERVAL_MS = 6 * 60 * 60_000;
/** Journal rows older than this are pruned; bounded without an operator. */
const JOURNAL_RETENTION_MS = 90 * 24 * 60 * 60_000;

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

  // The Slack toolbelt exists only when the bridge is addressable — like
  // attachments, absence of configuration means absence of capability. A
  // factory, because an MCP server instance serves exactly one session.
  // Routines ride the same condition: standing work that cannot post is
  // standing work that cannot report, which is worse than none.
  const bridgeBaseUrl = config.bridgeBaseUrl;
  const routines = bridgeBaseUrl === undefined ? undefined : new RoutineStore(
    join(dirname(config.dbPath), "routines.db"),
  );
  const toolbeltFactory =
    bridgeBaseUrl === undefined
      ? undefined
      : () => ({
          thicket: buildToolbelt({
            bridgeBaseUrl,
            fetchImpl: egressFetch(config.egressSocket),
            cwd: entry.harness.cwd,
            ...(routines === undefined ? {} : { routines }),
          }),
        });
  if (toolbeltFactory === undefined) {
    logger.info("slack toolbelt disabled: no bridge_base_url configured");
  }
  // Re-read at each session spawn so a persona edit in agents.yaml takes
  // effect on the next session, no restart needed. A file that has gone
  // unreadable or invalid falls back to the persona loaded at startup —
  // a stale persona beats a session that cannot spawn.
  const personaPrompt = (): string | undefined => {
    try {
      return parseRoster(readFileSync(config.agentsFile, "utf8")).agents[config.agent]?.persona;
    } catch (err) {
      logger.warn("roster re-read failed; using startup persona", { err: String(err) });
      return entry.persona;
    }
  };
  const sessions = new SessionManager({
    harness: entry.harness,
    env: sessionEnv(config),
    maxSessions: config.maxSessions,
    personaPrompt,
    onWarning: (msg) => logger.warn(msg),
    ...(toolbeltFactory === undefined
      ? {}
      : {
          mcpServers: toolbeltFactory,
          allowedTools: TOOLBELT_ALLOWED_TOOLS,
        }),
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
  // The journal lives beside the task store: same account, same lifecycle.
  const journal = new JournalStore(join(dirname(config.dbPath), "journal.db"));
  const executor = new ClaudeAgentExecutor({
    sessions,
    onWarning: (msg) => logger.warn(msg),
    ...(attachments === undefined ? {} : { attachments }),
    onTurnResult: (record) => {
      try {
        journal.record({ ts: new Date().toISOString(), agent: config.agent, ...record });
      } catch (err) {
        logger.warn("journal write failed", { taskId: record.taskId, err: String(err) });
      }
    },
  });
  const handler = new DefaultRequestHandler(card, store, executor);

  // Routine turns enter through the same request handler as everything
  // else — agentd is its own A2A requester — so the task store, the
  // journal (trigger: routine), and the translator all just apply. The
  // reply text streams back here and is discarded: a routine that has
  // something to say says it through the toolbelt.
  const routineContext = new ServerCallContext({
    user: { isAuthenticated: true, userName: "routine" },
  });
  const runRoutineTurn = async (routineId: string, prompt: string): Promise<RoutineTurnResult> => {
    const message: Message = {
      messageId: `routine-${routineId}-${randomUUID()}`,
      // One stable context per routine: consecutive runs share a session,
      // which is how "what did I already report?" answers itself.
      contextId: deriveSessionId("routine", routineId),
      taskId: "",
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: "text", value: prompt },
          mediaType: "text/plain",
          filename: "",
          metadata: {},
        },
      ],
      metadata: { [META_TRIGGER]: "routine" },
      extensions: [],
      referenceTaskIds: [],
    };
    const result = await handler.sendMessage(
      { tenant: "", message, configuration: undefined, metadata: undefined },
      routineContext,
    );
    if (!("status" in result)) {
      return { state: "completed" }; // a bare Message reply is an answer
    }
    const task = result as Task;
    const taskState = task.status?.state;
    const errorText = (task.status?.message?.parts ?? [])
      .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
      .join("");
    switch (taskState) {
      case TaskState.TASK_STATE_COMPLETED:
        return { state: "completed" };
      case TaskState.TASK_STATE_INPUT_REQUIRED:
        return { state: "input-required" };
      case TaskState.TASK_STATE_CANCELED:
        return { state: "canceled", ...(errorText === "" ? {} : { error: errorText }) };
      default:
        return { state: "failed", ...(errorText === "" ? {} : { error: errorText }) };
    }
  };
  const runner =
    routines === undefined
      ? undefined
      : new RoutineRunner({ store: routines, runTurn: runRoutineTurn, logger });
  runner?.start();
  if (runner !== undefined) {
    logger.info("routine scheduler running", { routines: routines?.list().length ?? 0 });
  }

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
    try {
      const dropped = journal.prune(JOURNAL_RETENTION_MS);
      if (dropped > 0) {
        logger.info("pruned journal", { count: dropped });
      }
    } catch (err) {
      logger.warn("journal prune failed", { err: String(err) });
    }
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
    runner?.stop();
    server.close(() => {
      void sessions.shutdown().then(() => {
        store.close();
        journal.close();
        routines?.close();
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
