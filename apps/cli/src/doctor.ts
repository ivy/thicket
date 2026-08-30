import type { Roster } from "@thicket/roster";
import { nodeName } from "@thicket/roster";

/** External probes the doctor runs. All read-only; faked in tests. */
export interface DoctorProbes {
  /** Fetch and parse an agent's card; throws when unreachable/invalid. */
  fetchCard(agent: string): Promise<{ name: string }>;
  /** Tailnet nodes visible to this operator, with their ACL tags. */
  tailnetNodes(): Promise<{ hostname: string; tags: string[] }[]>;
  /** Slack app state per agent (undefined: app unknown/not provisioned). */
  slackApp(agent: string): Promise<{ installed: boolean; socketMode: boolean } | undefined>;
  /** Installed app count and the workspace's cap. */
  workspaceAppUsage(): Promise<{ installed: number; cap: number }>;
  /** loginctl lingering for the agent's unix account on its host. */
  lingeringEnabled(agent: string, user: string): Promise<boolean>;
  /** The bridge's heartbeat file, if a bridge runs on this host. */
  bridgeHealth(): Promise<BridgeHealth | undefined>;
  /**
   * The phone number's live voice settings against the rendered ones, when
   * the operator has a twilio.json here (undefined: no phone to check).
   */
  phoneNumber(): Promise<{ number: string; drift: string[] } | undefined>;
  /** The phone bridge's config on this host: loadable, 0600, PIN and allow-list present (undefined: none here). */
  phoneConfig(): Promise<{ ok: true } | { ok: false; error: string } | undefined>;
  /** The public hostname answering, as Twilio would see it (undefined: no twilio.json to name it). */
  phonePublic(): Promise<{ url: string; status: number } | undefined>;
  /** The phone bridge's heartbeat file, if a phone bridge runs on this host. */
  phoneHealth(): Promise<PhoneHealth | undefined>;
}

/** Shape of the heartbeat file the phone bridge rewrites every few seconds. */
export interface PhoneHealth {
  ts: string;
  openCalls: number;
}

/** Shape of the health file the bridge rewrites every few seconds. */
export interface BridgeHealth {
  ts: string;
  agents: { agent: string; connected: boolean; attempts: number }[];
}

/** Two missed heartbeats: the bridge is down or wedged, not merely busy. */
const BRIDGE_HEALTH_STALE_MS = 60_000;

/**
 * "Cannot check" is a diagnosis, not a crash. A missing binary is the
 * normal case on a development host and deserves a sentence, not a stack
 * trace — and one dead probe must never take the rest of the report down
 * with it.
 */
function describeProbeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const missing = /spawn (\S+) ENOENT/.exec(message);
  if (missing !== null) {
    return `cannot check: \`${missing[1]}\` is not installed on this host`;
  }
  return `cannot check: ${message}`;
}

type Probed<T> = { ok: true; value: T } | { ok: false; error: string };

async function attempt<T>(fn: () => Promise<T>): Promise<Probed<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: describeProbeError(err) };
  }
}

export interface CheckResult {
  check: string;
  agent?: string;
  ok: boolean;
  message: string;
}

/**
 * Check and report, never mutate. Each failure mode gets a distinct,
 * actionable message; the caller exits non-zero when anything fails.
 */
export async function runDoctor(roster: Roster, probes: DoctorProbes): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const push = (check: string, ok: boolean, message: string, agent?: string) => {
    results.push({ check, agent, ok, message });
  };

  // Roster validity is proven by the fact it parsed (duplicates are
  // rejected by the schema); record it so the report says so explicitly.
  push("roster", true, `roster parses: ${Object.keys(roster.agents).length} agents`);

  const nodesProbe = await attempt(() => probes.tailnetNodes());
  if (!nodesProbe.ok) {
    push("tailnet", false, nodesProbe.error);
  }
  const byHostname = new Map(
    (nodesProbe.ok ? nodesProbe.value : []).map((node) => [node.hostname, node]),
  );

  for (const [agent, entry] of Object.entries(roster.agents)) {
    if (nodesProbe.ok) {
      const expectedNode = nodeName(entry);
      const node = byHostname.get(expectedNode);
      if (node === undefined) {
        push("tailnet", false, `no tailnet node named ${expectedNode}`, agent);
      } else if (!node.tags.includes(entry.tag)) {
        push(
          "tailnet",
          false,
          `tailnet node ${expectedNode} is missing tag ${entry.tag} (has: ${node.tags.join(", ") || "none"})`,
          agent,
        );
      } else {
        push("tailnet", true, `node ${expectedNode} carries ${entry.tag}`, agent);
      }
    }

    try {
      const card = await probes.fetchCard(agent);
      if (card.name !== agent) {
        push(
          "card",
          false,
          `card is stale: it names "${card.name}" but the roster says "${agent}" — re-deploy agentd`,
          agent,
        );
      } else {
        push("card", true, "agent card fetchable and current", agent);
      }
    } catch (err) {
      push(
        "card",
        false,
        `agent card not fetchable: ${err instanceof Error ? err.message : String(err)}`,
        agent,
      );
    }

    const appProbe = await attempt(() => probes.slackApp(agent));
    if (!appProbe.ok) {
      push("slack", false, appProbe.error, agent);
    } else if (appProbe.value === undefined) {
      push("slack", false, "no Slack app provisioned — run thicket provision", agent);
    } else if (!appProbe.value.installed) {
      push("slack", false, "Slack app exists but is not installed to the workspace", agent);
    } else if (!appProbe.value.socketMode) {
      push("slack", false, "Slack app installed but Socket Mode is disabled", agent);
    } else {
      push("slack", true, "Slack app installed with Socket Mode", agent);
    }

    const lingeringProbe = await attempt(() => probes.lingeringEnabled(agent, entry.user));
    if (!lingeringProbe.ok) {
      push("lingering", false, lingeringProbe.error, agent);
    } else if (!lingeringProbe.value) {
      push(
        "lingering",
        false,
        `account ${entry.user} has no lingering — nothing starts at boot; run: loginctl enable-linger ${entry.user}`,
        agent,
      );
    } else {
      push("lingering", true, `lingering enabled for ${entry.user}`, agent);
    }
  }

  const healthProbe = await attempt(() => probes.bridgeHealth());
  const health = healthProbe.ok ? healthProbe.value : undefined;
  if (!healthProbe.ok) {
    push("bridge", false, healthProbe.error);
  } else if (health === undefined) {
    push(
      "bridge",
      true,
      "no bridge health file on this host — run doctor where the bridge runs to check its connections",
    );
  } else {
    const ageMs = Date.now() - Date.parse(health.ts);
    if (!Number.isFinite(ageMs) || ageMs > BRIDGE_HEALTH_STALE_MS) {
      push(
        "bridge",
        false,
        `bridge health file is stale (last heartbeat ${Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s ago` : "unreadable"}) — the bridge is down or wedged`,
      );
    } else {
      for (const entry of health.agents) {
        if (entry.connected) {
          push("bridge", true, "Socket Mode connection up", entry.agent);
        } else {
          push(
            "bridge",
            false,
            `Socket Mode connection down (${entry.attempts} reconnect attempts) — see the bridge log`,
            entry.agent,
          );
        }
      }
    }
  }

  const phoneProbe = await attempt(() => probes.phoneNumber());
  if (!phoneProbe.ok) {
    push("phone", false, phoneProbe.error);
  } else if (phoneProbe.value === undefined) {
    push("phone", true, "no twilio.json on this host — the phone number is not checked here");
  } else if (phoneProbe.value.drift.length > 0) {
    push(
      "phone",
      false,
      `the number is not pointed at the bridge (${phoneProbe.value.drift.join("; ")}) — run thicket provision`,
    );
  } else {
    push("phone", true, "the number's voice URL and status callback point at the bridge");
  }

  // The phone path, link by link: the config, the public hostname, the
  // number, the heartbeat. Each says which link is broken and what to do.
  const phoneConfigProbe = await attempt(() => probes.phoneConfig());
  if (!phoneConfigProbe.ok) {
    push("phone", false, phoneConfigProbe.error);
  } else if (phoneConfigProbe.value === undefined) {
    push("phone", true, "no phone.json on this host — the phone bridge does not run here");
  } else if (!phoneConfigProbe.value.ok) {
    push("phone", false, `phone.json will not load: ${phoneConfigProbe.value.error}`);
  } else {
    push("phone", true, "phone.json loads: PIN, allow-list, and the Twilio auth token are present");
  }

  const publicProbe = await attempt(() => probes.phonePublic());
  if (!publicProbe.ok) {
    push("phone", false, `public hostname not answering: ${publicProbe.error} — is the phone account's netd up, and is Funnel permitted for its tag?`);
  } else if (publicProbe.value !== undefined) {
    if (publicProbe.value.status === 404) {
      push("phone", true, `public hostname answers from the bridge (${publicProbe.value.url})`);
    } else {
      push(
        "phone",
        false,
        `public hostname ${publicProbe.value.url} answered HTTP ${publicProbe.value.status}, not the bridge's 404 — ${publicProbe.value.status === 502 ? "netd is up but nothing is listening behind it: the phone bridge is down" : "something else is in front, or netd's prefix is wrong"}`,
      );
    }
  }

  const healthProbe2 = await attempt(() => probes.phoneHealth());
  if (!healthProbe2.ok) {
    push("phone", false, healthProbe2.error);
  } else if (healthProbe2.value === undefined) {
    push("phone", true, "no phone heartbeat on this host — run doctor where the phone bridge runs to check it is serving");
  } else {
    const ageMs = Date.now() - Date.parse(healthProbe2.value.ts);
    if (!Number.isFinite(ageMs) || ageMs > BRIDGE_HEALTH_STALE_MS) {
      push(
        "phone",
        false,
        `phone heartbeat is stale (last ${Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s ago` : "unreadable"}) — the phone bridge is down or wedged; see the runbook before restarting, a restart drops live calls`,
      );
    } else {
      push("phone", true, `phone bridge heartbeat fresh, ${healthProbe2.value.openCalls} call${healthProbe2.value.openCalls === 1 ? "" : "s"} open`);
    }
  }

  const usageProbe = await attempt(() => probes.workspaceAppUsage());
  if (!usageProbe.ok) {
    push("workspace", false, usageProbe.error);
  } else if (usageProbe.value.installed >= usageProbe.value.cap) {
    push(
      "workspace",
      false,
      `workspace is at its app cap (${usageProbe.value.installed}/${usageProbe.value.cap} installed) — installing another agent will fail`,
    );
  } else {
    push(
      "workspace",
      true,
      `workspace app usage ${usageProbe.value.installed}/${usageProbe.value.cap}`,
    );
  }

  return results;
}

export function doctorExitCode(results: CheckResult[]): number {
  return results.every((result) => result.ok) ? 0 : 1;
}

export function formatResults(results: CheckResult[]): string[] {
  return results.map(
    (result) =>
      `${result.ok ? "ok " : "FAIL"} [${result.check}]${result.agent !== undefined ? ` ${result.agent}` : ""}: ${result.message}`,
  );
}
