import { timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { RemoteAgentClient, type AgentClient } from "@thicket/a2a-client";
import { agentUrl, configDir, parseRoster, phoneEnabledAgents, socketPath, stateDir } from "@thicket/roster";

import { maskNumber, SlackAlertPoster } from "./alerts.js";
import { loadPhoneConfig } from "./config.js";
import { CallEngine, type AlertPort, type EngineLogger } from "./engine.js";
import { CallRegistry } from "./registry.js";
import { buildPhoneServer } from "./server.js";

function jsonLogger(): EngineLogger {
  const write = (level: string, msg: string, fields?: Record<string, unknown>) => {
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n");
  };
  return {
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
  };
}

/** Constant-time PIN compare; the entered digits are never kept or logged. */
export function pinVerifier(pin: string): (digits: string) => boolean {
  const expected = Buffer.from(pin);
  return (digits) => {
    const given = Buffer.from(digits);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
}

export async function run(
  configPath: string = process.env.THICKET_PHONE_CONFIG ?? join(configDir(), "phone.json"),
): Promise<void> {
  const logger = jsonLogger();
  // Refuses, naming the field, when the PIN or the allow-list is missing.
  const config = loadPhoneConfig(configPath);
  const roster = parseRoster(readFileSync(config.agents_file ?? join(configDir(), "agents.yaml"), "utf8"));
  const agents = phoneEnabledAgents(roster);
  if (agents.length === 0) {
    logger.warn("no agent has phone.enabled in the roster: callers will authenticate and be told so");
  }

  const registry = new CallRegistry(config.db_path ?? join(stateDir(), "phone", "phone.db"));
  const open = registry.openCalls();
  if (open.length > 0) {
    logger.info("calls still open from before this start", { count: open.length });
  }

  // Per-agent base-URL overrides for local development (no tailnet):
  // {"hearth": "http://127.0.0.1:8791"}.
  const endpointOverrides: Record<string, string> =
    process.env.THICKET_PHONE_ENDPOINTS !== undefined
      ? (JSON.parse(process.env.THICKET_PHONE_ENDPOINTS) as Record<string, string>)
      : {};
  const clients = new Map<string, AgentClient>();
  for (const agent of agents) {
    const entry = roster.agents[agent.name]!;
    clients.set(
      agent.name,
      new RemoteAgentClient(endpointOverrides[agent.name] ?? agentUrl(entry).replace(/\/a2a\/v1$/, "")),
    );
  }

  // Every alert is a log line (numbers masked); with a channel configured it is a Slack message too.
  const logAlert: AlertPort = {
    post: (alert) =>
      logger.info("alert", {
        ...alert,
        ...("from" in alert ? { from: maskNumber(alert.from) } : {}),
      }),
  };
  const poster =
    config.alerts === undefined
      ? undefined
      : new SlackAlertPoster({
          channel: config.alerts.channel,
          botToken: config.alerts.bot_token,
          showNumbers: config.alerts.show_numbers,
          logger,
        });
  if (poster === undefined) {
    logger.warn("alerts: no channel configured; alerts are log lines only");
  }
  const alerts: AlertPort = {
    post: async (alert) => {
      await logAlert.post(alert);
      await poster?.post(alert);
    },
  };

  const allowed = new Set(config.operator_numbers);
  const phone = buildPhoneServer({
    publicBaseUrl: config.public_base_url,
    authToken: config.twilio.auth_token,
    registry,
    alerts,
    logger,
    engineFor: (relay, engineAlerts) =>
      new CallEngine({
        agents,
        clientFor: (name) => {
          const client = clients.get(name);
          if (client === undefined) {
            throw new Error(`no client for agent ${name}`);
          }
          return client;
        },
        relay,
        state: registry,
        alerts: engineAlerts,
        verifyPin: pinVerifier(config.pin),
        callerAllowed: (from) => allowed.has(from),
        warmUp: config.warm_up,
        lockout: {
          lockedUntil: (from) => registry.lockedUntil(from, Date.now()),
          failedCall: (from) =>
            registry.recordFailedCall(from, Date.now(), {
              failedCalls: config.lockout.failed_calls,
              windowSeconds: config.lockout.window_seconds,
              cooldownSeconds: config.lockout.cooldown_seconds,
            }),
        },
        logger,
      }),
  });

  if (config.listen !== undefined) {
    const [hostname, port] = config.listen.split(":");
    await new Promise<void>((resolve) => phone.server.listen(Number(port), hostname, () => resolve()));
    logger.info("phone bridge up", { listen: config.listen, agents: agents.map((a) => a.name) });
  } else {
    const path = config.socket_path ?? socketPath("phone");
    mkdirSync(dirname(path), { recursive: true });
    rmSync(path, { force: true });
    await new Promise<void>((resolve) => phone.server.listen(path, () => resolve()));
    logger.info("phone bridge up", { socket: path, agents: agents.map((a) => a.name) });
  }

  const stop = () => {
    logger.info("phone bridge stopping", {});
    void phone.close().then(() => {
      registry.close();
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
