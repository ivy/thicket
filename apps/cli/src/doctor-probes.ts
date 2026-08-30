import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { agentUrl, configDir, parseRoster, stateDir } from "@thicket/roster";
import type { AgentEntry } from "@thicket/roster";

import type { BridgeHealth, DoctorProbes, PhoneHealth } from "./doctor.js";
import {
  desiredNumberSettings,
  HttpTwilioNumberApi,
  readTwilioProvisioning,
  settingsDrift,
} from "./phone-provision.js";
import type { FileStore } from "./store.js";

const execFileAsync = promisify(execFile);

/**
 * Real-world probes for `thicket doctor`. Read-only by construction:
 * `tailscale status`, `loginctl show-user`, card GETs, and Slack reads.
 */
export function realProbes(options: {
  roster?: ReturnType<typeof parseRoster>;
  tailnetDomain?: string;
  /** Dev-rig stand-in for the tailnet: agent name -> local base URL. */
  endpointOverrides?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** The operator's config dir, where twilio.json lives when there is a phone. */
  store?: FileStore;
} = {}): DoctorProbes {
  const fetchImpl = options.fetchImpl ?? fetch;
  const entryFor = (agent: string): AgentEntry | undefined => options.roster?.agents[agent];

  return {
    async fetchCard(agent) {
      const entry = entryFor(agent);
      if (entry === undefined) {
        throw new Error("agent missing from roster");
      }
      const base =
        options.endpointOverrides?.[agent] ??
        agentUrl(entry, { tailnetDomain: options.tailnetDomain }).replace(/\/a2a\/v1$/, "");
      let response: Response;
      try {
        response = await fetchImpl(`${base}/.well-known/agent-card.json`);
      } catch (err) {
        // Node's fetch says only "fetch failed"; the cause has the truth,
        // and an unresolvable tailnet name deserves its own sentence.
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
        const detail = cause instanceof Error ? cause.message : String(cause);
        if (/ENOTFOUND|EAI_AGAIN/.test(detail)) {
          throw new Error(
            `${new URL(base).hostname} does not resolve from here — no tailnet on this ` +
              `host? (dev rigs set THICKET_MCP_ENDPOINTS to probe local agents)`,
          );
        }
        throw new Error(detail);
      }
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

    async phoneNumber() {
      const creds = options.store === undefined ? undefined : readTwilioProvisioning(options.store);
      if (creds === undefined) {
        return undefined;
      }
      const live = await new HttpTwilioNumberApi(creds, fetchImpl).lookup(creds.number);
      if (live === undefined) {
        throw new Error("the Twilio account does not own the number in twilio.json");
      }
      return { number: creds.number, drift: settingsDrift(live.settings, desiredNumberSettings(creds.public_base_url)) };
    },

    async phoneConfig() {
      const path = join(configDir(), "phone.json");
      try {
        await readFile(path);
      } catch {
        return undefined;
      }
      // The bridge's own loader, so doctor and the bridge disagree about nothing.
      const { loadPhoneConfig } = await import("@thicket/phone");
      try {
        loadPhoneConfig(path);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async phonePublic() {
      const creds = options.store === undefined ? undefined : readTwilioProvisioning(options.store);
      if (creds === undefined) {
        return undefined;
      }
      const url = `${creds.public_base_url.replace(/\/$/, "")}/`;
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      return { url, status: response.status };
    },

    async phoneHealth() {
      try {
        const raw = await readFile(join(stateDir(), "phone", "health.json"), "utf8");
        return JSON.parse(raw) as PhoneHealth;
      } catch {
        return undefined;
      }
    },

    async lingeringEnabled(_agent, user) {
      // Throws when loginctl is absent (macOS, containers): "cannot
      // check" is the honest report there, not "no lingering".
      const { stdout } = await execFileAsync("loginctl", [
        "show-user",
        user,
        "--property=Linger",
      ]);
      return stdout.trim() === "Linger=yes";
    },
  };
}
