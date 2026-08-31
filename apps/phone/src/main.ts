import { timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { RemoteAgentClient, type AgentClient } from "@thicket/a2a-client";
import { assertEgressSocket, egressFetch, shareSocketWithGroup } from "@thicket/egress";
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

const HEALTH_INTERVAL_MS = 15_000;

/** Shape of the heartbeat file the phone bridge rewrites every few seconds. */
export interface PhoneHealth {
  ts: string;
  openCalls: number;
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
  // The phone bridge is the one component the public internet reaches, so
  // what it can reach back is worth being exact about: everything it sends
  // leaves through netd, and there is no second way out. Checked before
  // anything dials, because a process that finds this out at its first
  // outbound call has already been running as something it should not be.
  const egressSocket = config.egress_socket ?? socketPath("netd-egress");
  assertEgressSocket(egressSocket);
  const outbound = egressFetch(egressSocket);
  logger.info("egress socket", { path: egressSocket });

  const clients = new Map<string, AgentClient>();
  for (const agent of agents) {
    const entry = roster.agents[agent.name]!;
    clients.set(
      agent.name,
      new RemoteAgentClient(
        endpointOverrides[agent.name] ?? agentUrl(entry).replace(/\/a2a\/v1$/, ""),
        outbound,
      ),
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
          fetchImpl: outbound,
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
    // Only netd may connect: as this user, or as another one in the group.
    // Without this the socket keeps the unit's 0077 umask and a netd running
    // as its own user — the split the firewall rule needs — cannot dial it.
    shareSocketWithGroup(path, config.socket_group);
    logger.info("phone bridge up", {
      socket: path,
      group: config.socket_group,
      agents: agents.map((a) => a.name),
    });
  }

  // A heartbeat file `thicket doctor` can read: fresh means the bridge is
  // up and serving; the open-call count says whether a restart would drop
  // someone. Written atomically so a torn read never looks like a wedge.
  const healthPath = join(stateDir(), "phone", "health.json");
  mkdirSync(dirname(healthPath), { recursive: true });
  const writeHealth = () => {
    try {
      const doc = { ts: new Date().toISOString(), openCalls: registry.openCalls().length };
      // 0644, not the unit's 0077 umask. The heartbeat exists to be read by
      // an operator running `thicket doctor` from their own account, and the
      // directory above decides who can get to it: private under a user
      // deployment, the service manager's 0755 under a system one. A mode
      // that admits only the service's own group admits nobody at all — that
      // group has one member, and putting the operator in it would hand them
      // the account that holds every token to read a timestamp. Nothing here
      // is a secret: a time, and how many connections or calls are up.
      writeFileSync(healthPath + ".tmp", JSON.stringify(doc) + "\n");
      // chmod rather than the create mode, which the unit's 0077 umask masks
      // straight back down to 0600 — the one value that helps nobody here.
      chmodSync(healthPath + ".tmp", 0o644);
      renameSync(healthPath + ".tmp", healthPath);
    } catch (err) {
      logger.warn("health file write failed", { path: healthPath, err: String(err) });
    }
  };
  writeHealth();
  const healthTimer = setInterval(writeHealth, HEALTH_INTERVAL_MS);
  healthTimer.unref();

  const stop = () => {
    logger.info("phone bridge stopping", { openCalls: registry.openCalls().length });
    clearInterval(healthTimer);
    void phone.close().then(() => {
      registry.close();
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
