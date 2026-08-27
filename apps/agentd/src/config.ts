import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cacheDir, configDir, socketPath, stateDir } from "@thicket/roster";

/**
 * agentd's per-account configuration, rendered by the provisioning CLI
 * into $XDG_CONFIG_HOME/thicket/agentd.json.
 */
export interface AgentdConfig {
  /** Roster file; this daemon serves one of its agents. */
  agentsFile: string;
  /** Which roster agent this account runs. */
  agent: string;
  /**
   * Peer ACL tags allowed to call this agent, as verified by netd's WhoIs
   * and delivered in the peer-tags header. Absent or unknown peers are
   * rejected.
   */
  allowedPeerTags: string[];
  dbPath: string;
  socketPath: string;
  /** Tailnet DNS suffix for the card's interface URL. */
  tailnetDomain?: string;
  /** Explicit subprocess env vars for Claude Code sessions. */
  env: Record<string, string>;
  /** Names of process env vars to pass through to sessions (credentials). */
  envPassthrough: string[];
  maxSessions?: number;
  /** Where attachments are streamed to before the model opens them. */
  attachmentsDir: string;
  /** netd's outbound proxy socket; the only route off this machine. */
  egressSocket: string;
  /**
   * The bridge's base URL on the tailnet, for the agent's Slack toolbelt.
   * Absent means no toolbelt: the session gets no Slack tools at all.
   */
  bridgeBaseUrl?: string;
}

interface RawConfig {
  agents_file?: string;
  agent?: string;
  allowed_peer_tags?: string[];
  db_path?: string;
  socket_path?: string;
  tailnet_domain?: string;
  env?: Record<string, string>;
  env_passthrough?: string[];
  max_sessions?: number;
  attachments_dir?: string;
  egress_socket?: string;
  bridge_base_url?: string;
}

export function defaultConfigPath(): string {
  return join(configDir(), "agentd.json");
}

export function loadConfig(path: string): AgentdConfig {
  let raw: RawConfig;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as RawConfig;
  } catch (err) {
    throw new Error(
      `agentd config ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof raw.agent !== "string" || raw.agent === "") {
    throw new Error(`agentd config ${path}: "agent" is required`);
  }
  if (!Array.isArray(raw.allowed_peer_tags) || raw.allowed_peer_tags.length === 0) {
    throw new Error(
      `agentd config ${path}: "allowed_peer_tags" must list at least one tag — ` +
        `an empty allow-list would reject every caller including the bridge`,
    );
  }
  return {
    agentsFile: raw.agents_file ?? join(configDir(), "agents.yaml"),
    agent: raw.agent,
    allowedPeerTags: raw.allowed_peer_tags,
    dbPath: raw.db_path ?? join(stateDir(), "agentd", "tasks.db"),
    socketPath: raw.socket_path ?? socketPath("agentd"),
    tailnetDomain: raw.tailnet_domain,
    env: raw.env ?? {},
    envPassthrough: raw.env_passthrough ?? [],
    maxSessions: raw.max_sessions,
    attachmentsDir: raw.attachments_dir ?? join(cacheDir(), "attachments"),
    egressSocket: raw.egress_socket ?? socketPath("netd-egress"),
    ...(raw.bridge_base_url === undefined ? {} : { bridgeBaseUrl: raw.bridge_base_url }),
  };
}

/**
 * Subprocess environment for Claude Code sessions: PATH and HOME always,
 * plus explicitly passed-through credentials and explicit overrides. The
 * SDK replaces the environment wholesale, so nothing else leaks in.
 */
export function sessionEnv(config: AgentdConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    // Required for macOS keychain credential lookup in the CLI.
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
  };
  for (const name of config.envPassthrough) {
    env[name] = process.env[name];
  }
  Object.assign(env, config.env);
  return env;
}
