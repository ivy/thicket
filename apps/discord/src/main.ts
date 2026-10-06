import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { RemoteAgentClient } from "@thicket/a2a-client";
import { assertEgressSocket, egressAgent, egressFetch } from "@thicket/egress";
import { agentUrl, configDir, parseRoster, socketPath, stateDir } from "@thicket/roster";

import { AgentConnection } from "./connection.js";
import { RestDiscordApi } from "./discord-api.js";
import { BridgeEngine } from "./engine.js";
import { DiscordRest, InvalidResponseBreaker } from "./rest.js";
import { BridgeState } from "./state.js";
import { ConnectionSupervisor } from "./supervisor.js";
import type { EngineLogger } from "./types.js";

const QUEUE_FLUSH_INTERVAL_MS = 30_000;
const HEALTH_INTERVAL_MS = 15_000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60_000;
/** Matches the agent-side attachment cache's retention. */
const FILE_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** How long a handled message id is remembered; a resume replays far less. */
const HANDLED_RETENTION_MS = 24 * 60 * 60_000;

interface BridgeAgentConfig {
  application_id: string;
  bot_token: string;
}

/** The bridge's own config: shaped like the Slack bridge's, plus the Discord facts. */
export interface BridgeConfig {
  agents_file?: string;
  db_path?: string;
  tailnet_domain?: string;
  file_base_url?: string;
  socket_path?: string;
  socket_group?: string;
  egress_socket?: string;
  /** The one server the bridge serves. */
  guild_id: string;
  /** Discord user ids who may give agents work. */
  operators: string[];
  /** Bot user ids admitted as operators by the live-test harness only. */
  test_bots?: string[];
  agents: Record<string, BridgeAgentConfig>;
}

function jsonLogger(): EngineLogger {
  const write = (level: string, msg: string, fields?: Record<string, unknown>) => {
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n");
  };
  return {
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
  };
}

/**
 * The facts the bridge cannot run without, checked before anything dials,
 * because each is the ordinary first-run mistake and deserves better than
 * a TypeError out of Object.entries(undefined).
 */
export function assertConfigured(config: Partial<BridgeConfig>, configPath: string): asserts config is BridgeConfig {
  if (config.agents === undefined || Object.keys(config.agents).length === 0) {
    throw new Error(
      `Discord bridge config ${configPath}: "agents" must map each agent to its application, as ` +
        `{"<agent>": {"application_id": "…", "bot_token": "…"}} — mint both on the application's Bot page`,
    );
  }
  if (typeof config.guild_id !== "string" || config.guild_id === "") {
    throw new Error(`Discord bridge config ${configPath}: "guild_id" names the one server the bridge serves`);
  }
  if (!Array.isArray(config.operators) || config.operators.length === 0) {
    throw new Error(
      `Discord bridge config ${configPath}: "operators" lists the Discord user ids who may give agents work; ` +
        `with nobody listed, nothing is a turn`,
    );
  }
}

export async function run(
  configPath: string = process.env.THICKET_DISCORD_CONFIG ?? join(configDir(), "discord.json"),
): Promise<void> {
  const logger = jsonLogger();
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Partial<BridgeConfig>;
  assertConfigured(config, configPath);
  const roster = parseRoster(readFileSync(config.agents_file ?? join(configDir(), "agents.yaml"), "utf8"));

  // The bridge holds every agent's bot token and is meant to run with no
  // network of its own, so every leg — Discord, the agents — leaves
  // through netd. Checked before anything dials.
  const egressSocket = config.egress_socket ?? socketPath("netd-egress");
  assertEgressSocket(egressSocket);
  const outbound = egressFetch(egressSocket);
  const socketAgent = egressAgent(egressSocket);
  logger.info("egress socket", { path: egressSocket });

  // The harness's exemption from the loop guard is never on by accident:
  // it needs the config key and the environment variable both.
  const harness = process.env.THICKET_DISCORD_TEST_HARNESS === "1";
  if (config.test_bots !== undefined && config.test_bots.length > 0 && !harness) {
    logger.warn("test_bots is set but THICKET_DISCORD_TEST_HARNESS is not; ignoring it", {
      count: config.test_bots.length,
    });
  }
  const testBots = harness ? (config.test_bots ?? []) : [];

  const state = new BridgeState(config.db_path ?? join(stateDir(), "discord", "discord.db"));
  const breaker = new InvalidResponseBreaker();

  const endpointOverrides: Record<string, string> =
    process.env.THICKET_DISCORD_ENDPOINTS !== undefined
      ? (JSON.parse(process.env.THICKET_DISCORD_ENDPOINTS) as Record<string, string>)
      : {};

  const engines = new Map<string, BridgeEngine>();
  const connections = new Map<string, AgentConnection>();
  for (const [name, agentConfig] of Object.entries(config.agents)) {
    const entry = roster.agents[name];
    if (entry === undefined) {
      throw new Error(`Discord bridge config names unknown agent ${name}`);
    }
    if (!entry.discord.enabled) {
      logger.warn("agent has Discord credentials but discord.enabled is false in the roster; skipping", { agent: name });
      continue;
    }
    const scoped: EngineLogger = {
      info: (msg, fields) => logger.info(msg, { agent: name, ...fields }),
      warn: (msg, fields) => logger.warn(msg, { agent: name, ...fields }),
    };
    const rest = new DiscordRest({ token: agentConfig.bot_token, fetchImpl: outbound, breaker, logger: scoped });
    const engine = new BridgeEngine({
      agent: name,
      guildId: config.guild_id,
      operators: config.operators,
      testBots,
      selfId: () => connections.get(name)?.selfId,
      queueing: entry.queueing,
      context: entry.context,
      client: new RemoteAgentClient(
        endpointOverrides[name] ?? agentUrl(entry, { tailnetDomain: config.tailnet_domain }).replace(/\/a2a\/v1$/, ""),
        outbound,
      ),
      discord: new RestDiscordApi(rest),
      state,
      logger: scoped,
      ...(config.file_base_url === undefined ? {} : { fileBaseUrl: config.file_base_url }),
      ...(Object.keys(entry.discord.channels).length === 0 ? {} : { bindings: entry.discord.channels }),
    });
    engines.set(name, engine);
    await engine.start();
  }

  const supervisor = new ConnectionSupervisor({
    agents: [...engines.keys()],
    logger,
    factory: (agent) => {
      const engine = engines.get(agent)!;
      const scoped: EngineLogger = {
        info: (msg, fields) => logger.info(msg, { agent, ...fields }),
        warn: (msg, fields) => logger.warn(msg, { agent, ...fields }),
      };
      const connection = new AgentConnection(engine, {
        token: config.agents[agent]!.bot_token,
        sessions: state.sessions(agent),
        fetchImpl: outbound,
        agent: socketAgent,
        logger: scoped,
      });
      connections.set(agent, connection);
      return connection;
    },
  });
  await supervisor.start();
  logger.info("discord bridge up", { agents: [...engines.keys()] });

  // A heartbeat file `thicket doctor` can read: per-agent connection
  // state, freshly stamped, written atomically. 0644 on purpose: the
  // directory above decides who can reach it, and nothing in it is secret.
  const healthPath = join(stateDir(), "discord", "health.json");
  mkdirSync(dirname(healthPath), { recursive: true });
  const writeHealth = () => {
    try {
      const doc = { ts: new Date().toISOString(), agents: supervisor.health() };
      writeFileSync(healthPath + ".tmp", JSON.stringify(doc) + "\n");
      chmodSync(healthPath + ".tmp", 0o644);
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
    const files = state.pruneFiles(FILE_RETENTION_MS);
    const handled = state.pruneHandled(HANDLED_RETENTION_MS);
    if (files.length > 0 || handled > 0) {
      logger.info("pruned", { files: files.length, handled });
    }
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  const shutdown = () => {
    void supervisor.stop().then(() => {
      clearInterval(healthTimer);
      clearInterval(flushTimer);
      clearInterval(pruneTimer);
      state.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
