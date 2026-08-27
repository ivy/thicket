import { readFileSync } from "node:fs";
import { join } from "node:path";

import { WebClient } from "@slack/web-api";
import { agentUrl, configDir, parseRoster, stateDir } from "@thicket/roster";

import { BridgeEngine, type EngineLogger } from "./engine.js";
import { RemoteAgentClient } from "./a2a-client.js";
import { WebSlackApi } from "./slack-api.js";
import { SlackSocketConnection } from "./socket.js";
import { ConnectionSupervisor } from "./supervisor.js";
import { BridgeState } from "./state.js";

const QUEUE_FLUSH_INTERVAL_MS = 30_000;

interface BridgeAgentConfig {
  app_token: string;
  bot_token: string;
}

interface BridgeConfig {
  agents_file?: string;
  db_path?: string;
  tailnet_domain?: string;
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

export async function run(
  configPath: string = process.env.THICKET_BRIDGE_CONFIG ?? join(configDir(), "bridge.json"),
): Promise<void> {
  const logger = jsonLogger();
  const config = JSON.parse(readFileSync(configPath, "utf8")) as BridgeConfig;
  const roster = parseRoster(
    readFileSync(config.agents_file ?? join(configDir(), "agents.yaml"), "utf8"),
  );
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
      client: new RemoteAgentClient(
        endpointOverrides[name] ??
          agentUrl(entry, { tailnetDomain: config.tailnet_domain }).replace(/\/a2a\/v1$/, ""),
      ),
      slack: new WebSlackApi(new WebClient(agentConfig.bot_token)),
      state,
      logger,
    });
    engines.set(name, engine);
    await engine.start();
  }

  const supervisor = new ConnectionSupervisor({
    agents: [...engines.keys()],
    logger,
    factory: (agent) => {
      const engine = engines.get(agent)!;
      return new SlackSocketConnection(config.agents[agent]!.app_token, (event) => {
        void engine.handleEvent(event).catch((err: unknown) => {
          logger.warn("event handling failed", { agent, err: String(err) });
        });
      });
    },
  });
  await supervisor.start();
  logger.info("bridge up", { agents: [...engines.keys()] });

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

  const shutdown = () => {
    void supervisor.stop().then(() => {
      state.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
