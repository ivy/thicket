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

/** Everything the release archive installs, in the order it is listed. */
const THICKET_EXECUTABLES = [
  "thicket",
  "thicket-agentd",
  "thicket-bridge",
  "thicket-netd",
  "thicket-phone",
];

/**
 * The state directories a heartbeat could be in, most specific first.
 *
 * An edge component deployed as a system unit keeps its state in
 * /var/lib/thicket, and doctor is run by the operator from their own
 * account — so reading only this process's XDG state dir means a bridge
 * that is serving perfectly reports as absent. Both are checked, and the
 * one that answered is reported, because a wrong inference should be
 * visible rather than silent.
 */
const SYSTEM_STATE_DIR = "/var/lib/thicket";
const SYSTEM_CONFIG_DIR = "/etc/thicket";

async function readHealth<T>(component: string): Promise<(T & { source?: string }) | undefined> {
  const candidates = [
    { dir: SYSTEM_STATE_DIR, source: `${SYSTEM_STATE_DIR} (system unit)` },
    { dir: stateDir(), source: `${stateDir()} (this account)` },
  ];
  let shutOutOf: string | undefined;
  for (const { dir, source } of candidates) {
    const path = join(dir, component, "health.json");
    try {
      const raw = await readFile(path, "utf8");
      return { ...(JSON.parse(raw) as T), source };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        // A heartbeat that is there and cannot be read is not the same thing
        // as no deployment on this host: the component may be serving
        // perfectly and this account simply cannot see it. Held rather than
        // raised, because a readable one further down still answers the
        // question — this only matters when nothing does.
        shutOutOf ??= path;
      }
      // Absent or unparsable both mean "not here"; try the next shape.
    }
  }
  if (shutOutOf !== undefined) {
    throw new Error(
      `${shutOutOf} exists but this account cannot read it — the heartbeat is written for the operator, ` +
        `so a mode or a directory above it is wrong`,
    );
  }
  return undefined;
}

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
  /**
   * How that fetch leaves this host, for the lines that report a failure.
   * A card that cannot be fetched means something different depending on
   * whether the request went through netd or straight out.
   */
  route?: string;
  /** The operator's config dir, where twilio.json lives when there is a phone. */
  store?: FileStore;
} = {}): DoctorProbes {
  const fetchImpl = options.fetchImpl ?? fetch;
  const route = options.route ?? "this host's own network";
  const entryFor = (agent: string): AgentEntry | undefined => options.roster?.agents[agent];

  return {
    async installedVersions() {
      const found: { name: string; version: string; path: string }[] = [];
      for (const name of THICKET_EXECUTABLES) {
        try {
          const { stdout: which } = await execFileAsync("command", ["-v", name], {
            shell: "/bin/sh",
          });
          const path = which.trim();
          if (path === "") {
            continue;
          }
          const { stdout } = await execFileAsync(path, ["--version"]);
          found.push({ name, version: stdout.trim(), path });
        } catch {
          // Absent from PATH, or too old to answer: either way there is
          // nothing to report for this one, and the count below says so.
        }
      }
      return found;
    },

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
            `${new URL(base).hostname} does not resolve over ${route} — no tailnet on this ` +
              `host? (dev rigs set THICKET_MCP_ENDPOINTS to probe local agents)`,
          );
        }
        throw new Error(`${detail} (over ${route})`);
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
      return readHealth<BridgeHealth>("bridge");
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
      // Two layouts, as with the heartbeat. A system-unit deployment keeps
      // this file in /etc, root's alone, and hands the bridge a copy — so an
      // operator running doctor as themselves *cannot* read it, and that is
      // the file being right rather than absent. Reporting it as missing told
      // them the bridge does not run on a host where it was serving.
      const candidates = [
        { path: join(SYSTEM_CONFIG_DIR, "phone.json"), source: `${SYSTEM_CONFIG_DIR} (system unit)` },
        { path: join(configDir(), "phone.json"), source: `${configDir()} (this account)` },
      ];
      for (const { path, source } of candidates) {
        try {
          await readFile(path);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "EACCES" || code === "EPERM") {
            return { ok: true as const, source, unreadable: true as const };
          }
          continue;
        }
        // The bridge's own loader, so doctor and the bridge disagree about nothing.
        const { loadPhoneConfig } = await import("@thicket/phone");
        try {
          loadPhoneConfig(path);
          return { ok: true as const, source };
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : String(err), source };
        }
      }
      return undefined;
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
      return readHealth<PhoneHealth>("phone");
    },

    async startsAtBoot(_agent, user) {
      // The question is the same on both platforms and the answer is not.
      // On Linux an agent's user units survive logout only with lingering;
      // on macOS a LaunchAgent survives because it is bootstrapped into the
      // account's domain, and asking loginctl there produces a failure that
      // says nothing about whether the agent will come back.
      if (process.platform === "darwin") {
        const { stdout } = await execFileAsync("launchctl", ["list"]);
        return {
          enabled: stdout.split("\n").some((line) => line.includes("com.thicket.agentd")),
          mechanism: "launchd: com.thicket.agentd bootstrapped",
        };
      }
      const { stdout } = await execFileAsync("loginctl", [
        "show-user",
        user,
        "--property=Linger",
      ]);
      return { enabled: stdout.trim() === "Linger=yes", mechanism: "loginctl lingering" };
    },
  };
}
