import type { Roster } from "@thicket/roster";
import { nodeName } from "@thicket/roster";

/** External probes the doctor runs. All read-only; faked in tests. */
export interface DoctorProbes {
  /** Every thicket executable on PATH, and the release each reports. */
  installedVersions(): Promise<{ name: string; version: string; path: string }[]>;
  /** Fetch and parse an agent's card; throws when unreachable/invalid. */
  fetchCard(agent: string): Promise<{ name: string }>;
  /** Tailnet nodes visible to this operator, with their ACL tags. */
  tailnetNodes(): Promise<{
    nodes: { hostname: string; tags: string[] }[];
    /** Empty when this machine is a member, which sees the whole tailnet. */
    selfTags: string[];
    selfHostname: string;
  }>;
  /** Slack app state per agent (undefined: app unknown/not provisioned). */
  slackApp(agent: string): Promise<{ installed: boolean; socketMode: boolean } | undefined>;
  /** Installed app count and the workspace's cap. */
  workspaceAppUsage(): Promise<{ installed: number; cap: number }>;
  /**
   * Whether the agent comes back after a reboot, and by what mechanism.
   * Lingering on Linux, a bootstrapped LaunchAgent on macOS — the question
   * is the same and the answer is not, so the probe reports which it asked.
   */
  startsAtBoot(agent: string, user: string): Promise<{ enabled: boolean; mechanism: string }>;
  /** The bridge's heartbeat file, if a bridge runs on this host. */
  bridgeHealth(): Promise<BridgeHealth | undefined>;
  /**
   * The phone number's live voice settings against the rendered ones, when
   * the operator has a twilio.json here (undefined: no phone to check).
   */
  phoneNumber(): Promise<{ number: string; drift: string[] } | undefined>;
  /** The phone bridge's config on this host: loadable, 0600, PIN and allow-list present (undefined: none here). */
  phoneConfig(): Promise<
    | { ok: true; source: string; unreadable?: true }
    | { ok: false; error: string; source: string }
    | undefined
  >;
  /** The public hostname answering, as Twilio would see it (undefined: no twilio.json to name it). */
  phonePublic(): Promise<{ url: string; status: number } | undefined>;
  /** The phone bridge's heartbeat file, if a phone bridge runs on this host. */
  phoneHealth(): Promise<PhoneHealth | undefined>;
}

/** Shape of the heartbeat file the phone bridge rewrites every few seconds. */
export interface PhoneHealth {
  ts: string;
  openCalls: number;
  /** Which layout answered — a system unit's /var/lib, or this account's. */
  source?: string;
}

/** Shape of the health file the bridge rewrites every few seconds. */
export interface BridgeHealth {
  ts: string;
  agents: { agent: string; connected: boolean; attempts: number }[];
  /** Which layout answered — a system unit's /var/lib, or this account's. */
  source?: string;
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
  const refused = /egress proxy refused CONNECT: (.+)/.exec(message);
  if (refused !== null) {
    return (
      `cannot check: this account's own netd refused the connection (${refused[1]}) — ` +
      `the host is not in its egress allow-list. This says nothing about whether the ` +
      `thing being checked is healthy`
    );
  }
  return `cannot check: ${message}`;
}

/**
 * Did the probe fail because it was not allowed out, rather than because the
 * target is broken? A caller refused by its own allow-list knows nothing about
 * the target, so any hint about what might be wrong with it is a guess — and a
 * guess printed beside a real error reads as a finding.
 */
function refusedByOwnEgress(probeError: string): boolean {
  return probeError.includes("egress allow-list");
}

type Probed<T> = { ok: true; value: T } | { ok: false; error: string };

async function attempt<T>(fn: () => Promise<T>): Promise<Probed<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: describeProbeError(err) };
  }
}

/**
 * Who may talk to an agent and where, in one sentence. Says the open
 * default out loud — an operator who has never heard of `reach` should
 * learn from this line that every member of the workspace can open a turn.
 */
function describeReach(entry: Roster["agents"][string]): string {
  const { operators, channels } = entry.reach;
  const who =
    operators === "anyone"
      ? "anyone in the workspace"
      : `${operators.length} operator${operators.length === 1 ? "" : "s"}`;
  const listed = Object.keys(entry.channels);
  const where =
    channels === "any"
      ? "any channel it is invited to"
      : `${listed.length} listed channel${listed.length === 1 ? "" : "s"} (${listed.join(", ")})`;
  const hint =
    operators === "anyone" ? " — constrain it with reach.operators in agents.yaml" : "";
  // The account, not the agent name: talking to an agent means running
  // as that unix user on that host, which is the blast radius being opened.
  return `${who} can open a turn as ${entry.user}@${entry.host}, in ${where}${hint}`;
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
    (nodesProbe.ok ? nodesProbe.value.nodes : []).map((node) => [node.hostname, node]),
  );
  // A tagged machine sees only what the policy lets it reach, so from here
  // "absent" and "not mine to see" are the same observation. Saying the first
  // when it is the second reports four healthy agents as missing.
  const partialView = nodesProbe.ok && nodesProbe.value.selfTags.length > 0;

  for (const [agent, entry] of Object.entries(roster.agents)) {
    if (nodesProbe.ok) {
      const expectedNode = nodeName(entry);
      const node = byHostname.get(expectedNode);
      if (node === undefined && partialView) {
        push(
          "tailnet",
          true,
          `${expectedNode} is not in this host's view of the tailnet: ${nodesProbe.value.selfHostname} is tagged ` +
            `(${nodesProbe.value.selfTags.join(", ")}), so its netmap holds only what the policy lets that tag ` +
            `reach — run doctor from a member device to check this node`,
          agent,
        );
      } else if (node === undefined) {
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

    // Reach is a fact, never a failure: the open default is what the fleet
    // shipped with, and doctor's job is to make sure the operator knows it
    // rather than to grade the choice.
    push("reach", true, describeReach(entry), agent);

    const lingeringProbe = await attempt(() => probes.startsAtBoot(agent, entry.user));
    if (!lingeringProbe.ok) {
      push("lingering", false, lingeringProbe.error, agent);
    } else if (!lingeringProbe.value.enabled) {
      push(
        "lingering",
        false,
        `account ${entry.user} has no lingering — nothing starts at boot; run: loginctl enable-linger ${entry.user}`,
        agent,
      );
    } else {
      push(
        "lingering",
        true,
        `${entry.user} starts at boot (${lingeringProbe.value.mechanism})`,
        agent,
      );
    }
  }

  // What is actually installed, which a path cannot answer: a symlink says
  // where a binary came from, not what is in it.
  const versionsProbe = await attempt(() => probes.installedVersions());
  if (!versionsProbe.ok) {
    push("version", false, versionsProbe.error);
  } else if (versionsProbe.value.length === 0) {
    push("version", false, "no thicket executables on PATH");
  } else {
    const versions = new Set(versionsProbe.value.map((v) => v.version));
    const summary = versionsProbe.value.map((v) => `${v.name} ${v.version}`).join(", ");
    if (versions.size > 1) {
      // The fleet's processes speak to each other and must move together.
      push("version", false, `installed binaries disagree: ${summary}`);
    } else {
      push("version", true, `installed: ${summary}`);
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
        `bridge health file is stale (last heartbeat ${Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s ago` : "unreadable"}, from ${health.source ?? "this account"}) — the bridge is down or wedged`,
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
    push("phone", false, `phone.json will not load: ${phoneConfigProbe.value.error} (${phoneConfigProbe.value.source})`);
  } else if (phoneConfigProbe.value.unreadable === true) {
    // Not a failure: a system unit is handed this file as a credential, so
    // the copy on disk is root's and nobody else's business to read.
    push(
      "phone",
      true,
      `phone.json is present and readable only by root, as a system-unit deployment wants (${phoneConfigProbe.value.source})`,
    );
  } else {
    push(
      "phone",
      true,
      `phone.json loads: PIN, allow-list, and the Twilio auth token are present (${phoneConfigProbe.value.source})`,
    );
  }

  const publicProbe = await attempt(() => probes.phonePublic());
  if (!publicProbe.ok) {
    push(
      "phone",
      false,
      refusedByOwnEgress(publicProbe.error)
        ? `public hostname not checked: ${publicProbe.error}`
        : `public hostname not answering: ${publicProbe.error} — is the phone account's netd up, and is Funnel permitted for its tag?`,
    );
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
