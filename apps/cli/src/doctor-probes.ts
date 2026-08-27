import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { agentUrl, parseRoster, stateDir } from "@thicket/roster";
import type { AgentEntry } from "@thicket/roster";

import type { BridgeHealth, DoctorProbes } from "./doctor.js";

const execFileAsync = promisify(execFile);

/**
 * Real-world probes for `thicket doctor`. Read-only by construction:
 * `tailscale status`, `loginctl show-user`, card GETs, and Slack reads.
 */
export function realProbes(options: {
  roster?: ReturnType<typeof parseRoster>;
  tailnetDomain?: string;
  fetchImpl?: typeof fetch;
} = {}): DoctorProbes {
  const fetchImpl = options.fetchImpl ?? fetch;
  const entryFor = (agent: string): AgentEntry | undefined => options.roster?.agents[agent];

  return {
    async fetchCard(agent) {
      const entry = entryFor(agent);
      if (entry === undefined) {
        throw new Error("agent missing from roster");
      }
      const base = agentUrl(entry, { tailnetDomain: options.tailnetDomain }).replace(
        /\/a2a\/v1$/,
        "",
      );
      const response = await fetchImpl(`${base}/.well-known/agent-card.json`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return (await response.json()) as { name: string };
    },

    async tailnetNodes() {
      const { stdout } = await execFileAsync("tailscale", ["status", "--json"]);
      const status = JSON.parse(stdout) as {
        Peer?: Record<string, { HostName: string; Tags?: string[] }>;
        Self?: { HostName: string; Tags?: string[] };
      };
      const nodes = Object.values(status.Peer ?? {}).map((peer) => ({
        hostname: peer.HostName,
        tags: peer.Tags ?? [],
      }));
      if (status.Self !== undefined) {
        nodes.push({ hostname: status.Self.HostName, tags: status.Self.Tags ?? [] });
      }
      return nodes;
    },

    async slackApp() {
      // Requires per-app credentials; until task 013 wires them, report
      // unknown so doctor flags it as unprovisioned rather than lying.
      return undefined;
    },

    async workspaceAppUsage() {
      // Slack has no public endpoint for the install count; the free-plan
      // cap is 10. Operators adjust via THICKET_WORKSPACE_APP_COUNT until
      // a better source exists.
      const installed = Number(process.env.THICKET_WORKSPACE_APP_COUNT ?? 0);
      return { installed, cap: 10 };
    },

    async bridgeHealth() {
      // Same path the bridge writes; absent or unparsable both mean "no
      // bridge heartbeat here", which doctor reports without failing.
      try {
        const raw = await readFile(join(stateDir(), "bridge", "health.json"), "utf8");
        return JSON.parse(raw) as BridgeHealth;
      } catch {
        return undefined;
      }
    },

    async lingeringEnabled(_agent, user) {
      try {
        const { stdout } = await execFileAsync("loginctl", [
          "show-user",
          user,
          "--property=Linger",
        ]);
        return stdout.trim() === "Linger=yes";
      } catch {
        return false;
      }
    },
  };
}
