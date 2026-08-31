import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

import { WebClient } from "@slack/web-api";
import { RemoteAgentClient } from "@thicket/a2a-client";
import { assertEgressSocket, egressAgent, egressFetch, shareSocketWithGroup } from "@thicket/egress";
import { agentUrl, configDir, parseRoster, socketPath, stateDir } from "@thicket/roster";

import { BridgeEngine, type EngineLogger } from "./engine.js";
import { buildFileServer } from "./http.js";
import { WebSlackApi } from "./slack-api.js";
import { SlackSocketConnection } from "./socket.js";
import { ConnectionSupervisor } from "./supervisor.js";
import { BridgeState } from "./state.js";

const QUEUE_FLUSH_INTERVAL_MS = 30_000;
const HEALTH_INTERVAL_MS = 15_000;
const FILE_PRUNE_INTERVAL_MS = 6 * 60 * 60_000;
/** Matches the agent-side attachment cache's retention. */
const FILE_RETENTION_MS = 30 * 24 * 60 * 60_000;

interface BridgeAgentConfig {
  app_token: string;
  bot_token: string;
}

interface BridgeConfig {
  agents_file?: string;
  db_path?: string;
  tailnet_domain?: string;
  /**
   * Base URL agents reach this bridge on, served by its own netd. Absent
   * means no file transfer: attachments are declined in-thread.
   */
  file_base_url?: string;
  /** Unix socket the file surface listens on; netd's upstream. */
  socket_path?: string;
  /**
   * Group that may reach that socket. Set it when netd runs as a different
   * user from the bridge — which is what lets a firewall rule drop the
   * bridge's egress and leave netd's alone. Absent: the socket is the
   * bridge's own, 0600.
   */
  socket_group?: string;
  /**
   * Unix socket netd's egress proxy listens on: the bridge's only way out,
   * for Slack and for the agents alike. Default: socketPath("netd-egress").
   */
  egress_socket?: string;
  agents: Record<string, BridgeAgentConfig>;
}

function jsonLogger(): EngineLogger {
  const write = (level: string, msg: string, fields?: Record<string, unknown>) => {
    process.stderr.write(
      JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n",
    );
  };
  return {
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
  };
}

/**
 * The file surface, bound to a unix socket for its own netd to front. A
 * TCP override exists for development, where there is no tailnet and the
 * peer-tag header comes from a stand-in proxy instead.
 */
async function startFileServer(
  config: BridgeConfig,
  roster: ReturnType<typeof parseRoster>,
  state: BridgeState,
  logger: EngineLogger,
  fetchImpl: typeof fetch,
): Promise<{ close(): void } | undefined> {
  if (config.file_base_url === undefined) {
    logger.info("file surface disabled: no file_base_url configured");
    return undefined;
  }
  const agentByTag = new Map<string, string>();
  for (const [name, entry] of Object.entries(roster.agents)) {
    if (config.agents[name] !== undefined) {
      agentByTag.set(entry.tag, name);
    }
  }
  const app = buildFileServer({
    state,
    agentByTag,
    botTokenFor: (agent) => config.agents[agent]?.bot_token,
    logger,
    fetchImpl,
  });
  const server = createServer(app);
  const path = config.socket_path ?? socketPath("bridge");
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  // Only netd may connect: as this user, or as another one in the group.
  shareSocketWithGroup(path, config.socket_group);
  logger.info("file surface listening", { addr: path, group: config.socket_group });
  return { close: () => server.close() };
}

/**
 * Each agent needs its own Slack credentials: an app-level token for the
 * Socket Mode connection and a bot token for the Web API. Neither is
 * rendered by provision — they do not exist until the app is installed —
 * so a config that omits them is the ordinary first-run mistake, and it
 * deserves better than a TypeError out of Object.entries(undefined).
 */
export function assertAgentsConfigured(
  config: { agents?: Record<string, unknown> },
  configPath: string,
): void {
  if (config.agents === undefined || Object.keys(config.agents).length === 0) {
    throw new Error(
      `bridge config ${configPath}: "agents" must map each agent to its Slack ` +
        `tokens, as {"<agent>": {"app_token": "xapp-…", "bot_token": "xoxb-…"}} — ` +
        `mint both on the agent's app page after installing it`,
    );
  }
}

export async function run(
  configPath: string = process.env.THICKET_BRIDGE_CONFIG ?? join(configDir(), "bridge.json"),
): Promise<void> {
  const logger = jsonLogger();
  const config = JSON.parse(readFileSync(configPath, "utf8")) as BridgeConfig;
  const roster = parseRoster(
    readFileSync(config.agents_file ?? join(configDir(), "agents.yaml"), "utf8"),
  );
  assertAgentsConfigured(config, configPath);

  // The bridge holds every agent's Slack tokens and is meant to run with no
  // network of its own, so every leg — Slack, the agents, the files it
  // redeems — leaves through netd. Checked before anything dials, because a
  // process that discovers this at the first outbound call has already been
  // running as something it should not be.
  const egressSocket = config.egress_socket ?? socketPath("netd-egress");
  assertEgressSocket(egressSocket);
  const outbound = egressFetch(egressSocket);
  const slackAgent = egressAgent(egressSocket);
  logger.info("egress socket", { path: egressSocket });

  const state = new BridgeState(config.db_path ?? join(stateDir(), "bridge", "bridge.db"));

  // Per-agent base-URL overrides for local development (no tailnet):
  // {"hearth": "http://127.0.0.1:8791"}.
  const endpointOverrides: Record<string, string> =
    process.env.THICKET_BRIDGE_ENDPOINTS !== undefined
      ? (JSON.parse(process.env.THICKET_BRIDGE_ENDPOINTS) as Record<string, string>)
      : {};

  const engines = new Map<string, BridgeEngine>();
  for (const [name, agentConfig] of Object.entries(config.agents)) {
    const entry = roster.agents[name];
    if (entry === undefined) {
      throw new Error(`bridge config names unknown agent ${name}`);
    }
    const engine = new BridgeEngine({
      agent: name,
      queueing: entry.queueing,
      context: entry.context,
      client: new RemoteAgentClient(
        endpointOverrides[name] ??
          agentUrl(entry, { tailnetDomain: config.tailnet_domain }).replace(/\/a2a\/v1$/, ""),
        outbound,
      ),
      slack: new WebSlackApi(new WebClient(agentConfig.bot_token, { agent: slackAgent }), logger),
      state,
      logger,
      ...(config.file_base_url === undefined ? {} : { fileBaseUrl: config.file_base_url }),
      ...(Object.keys(entry.channels).length === 0 ? {} : { bindings: entry.channels }),
    });
    engines.set(name, engine);
    await engine.start();
  }

  const fileServer = await startFileServer(config, roster, state, logger, outbound);

  const supervisor = new ConnectionSupervisor({
    agents: [...engines.keys()],
    logger,
    factory: (agent) => {
      const engine = engines.get(agent)!;
      // Scoped so every connection-level line — lifecycle, watchdog,
      // library warnings — says which agent's socket it is about.
      const scoped: EngineLogger = {
        info: (msg, fields) => logger.info(msg, { agent, ...fields }),
        warn: (msg, fields) => logger.warn(msg, { agent, ...fields }),
      };
      return new SlackSocketConnection(
        config.agents[agent]!.app_token,
        (event) => {
          void engine.handleEvent(event).catch((err: unknown) => {
            logger.warn("event handling failed", { agent, err: String(err) });
          });
        },
        scoped,
        { agent: slackAgent, fetchImpl: outbound },
      );
    },
  });
  await supervisor.start();
  logger.info("bridge up", { agents: [...engines.keys()] });

  // A heartbeat file `thicket doctor` can read: per-agent connection
  // state, freshly stamped, so "unhealthy" and "not running" are both
  // distinguishable from "present". Written atomically; a torn read must
  // not look like a wedged bridge.
  const healthPath = join(stateDir(), "bridge", "health.json");
  mkdirSync(dirname(healthPath), { recursive: true });
  const writeHealth = () => {
    try {
      const doc = { ts: new Date().toISOString(), agents: supervisor.health() };
      // 0640, not the unit's 0077 umask: the heartbeat exists to be read by
      // an operator running `thicket doctor` from their own account, and a
      // file only this service can read answers no question.
      writeFileSync(healthPath + ".tmp", JSON.stringify(doc) + "\n", { mode: 0o640 });
      renameSync(healthPath + ".tmp", healthPath);
    } catch (err) {
      logger.warn("health file write failed", { path: healthPath, err: String(err) });
    }
  };
  writeHealth();
  const healthTimer = setInterval(writeHealth, HEALTH_INTERVAL_MS);
  healthTimer.unref();

  const flushTimer = setInterval(() => {
    for (const engine of engines.values()) {
      void engine.flushQueue().then((n) => {
        if (n > 0) {
          logger.info("delivered queued requests", { count: n });
        }
      });
    }
  }, QUEUE_FLUSH_INTERVAL_MS);
  flushTimer.unref();

  const pruneTimer = setInterval(() => {
    const dropped = state.pruneFiles(FILE_RETENTION_MS);
    if (dropped > 0) {
      logger.info("pruned file descriptors", { count: dropped });
    }
  }, FILE_PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  const shutdown = () => {
    void supervisor.stop().then(() => {
      fileServer?.close();
      state.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
