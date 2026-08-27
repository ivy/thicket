import { readFileSync } from "node:fs";
import { join } from "node:path";

import { configDir, socketPath, stateDir } from "@thicket/roster";

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
  };
  for (const name of config.envPassthrough) {
    env[name] = process.env[name];
  }
  Object.assign(env, config.env);
  return env;
}
