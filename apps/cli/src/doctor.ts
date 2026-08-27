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

  const nodes = await probes.tailnetNodes();
  const byHostname = new Map(nodes.map((node) => [node.hostname, node]));

  for (const [agent, entry] of Object.entries(roster.agents)) {
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

    const app = await probes.slackApp(agent);
    if (app === undefined) {
      push("slack", false, "no Slack app provisioned — run thicket provision", agent);
    } else if (!app.installed) {
      push("slack", false, "Slack app exists but is not installed to the workspace", agent);
    } else if (!app.socketMode) {
      push("slack", false, "Slack app installed but Socket Mode is disabled", agent);
    } else {
      push("slack", true, "Slack app installed with Socket Mode", agent);
    }

    const lingering = await probes.lingeringEnabled(agent, entry.user);
    if (!lingering) {
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

  const usage = await probes.workspaceAppUsage();
  if (usage.installed >= usage.cap) {
    push(
      "workspace",
      false,
      `workspace is at its app cap (${usage.installed}/${usage.cap} installed) — installing another agent will fail`,
    );
  } else {
    push("workspace", true, `workspace app usage ${usage.installed}/${usage.cap}`);
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
