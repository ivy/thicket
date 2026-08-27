import type { Roster } from "@thicket/roster";
import { agentUrl } from "@thicket/roster";

import { A2aJsonRpcClient, taskText } from "./mcp/a2a.js";
import { CardCache } from "./mcp/card-cache.js";
import type { HttpDoer } from "./mcp/http.js";

export interface FleetAgentHealth {
  agent: string;
  up: boolean;
  /** Why it is down, or a short live summary. */
  detail: string;
  /** Tasks currently submitted or working. */
  inFlight: number;
  /** Text of the most recent failed task, if any. */
  lastError?: string;
}

export interface FleetDeps {
  http: HttpDoer;
  tailnetDomain?: string;
  /** Per-agent base-URL overrides, as in the MCP server. */
  endpointOverrides?: Record<string, string>;
}

/**
 * One command's worth of fleet truth, over A2A only: reachability via the
 * card, in-flight work and the last failure via ListTasks. Accurate when
 * an agent is down — that is the moment it matters.
 */
export async function fleetHealth(roster: Roster, deps: FleetDeps): Promise<FleetAgentHealth[]> {
  const cache = new CardCache(deps.http);
  const results: FleetAgentHealth[] = [];
  for (const [agent, entry] of Object.entries(roster.agents)) {
    const base =
      deps.endpointOverrides?.[agent] ??
      agentUrl(entry, { tailnetDomain: deps.tailnetDomain }).replace(/\/a2a\/v1$/, "");
    try {
      const card = await cache.get(agent, `${base}/.well-known/agent-card.json`);
      const client = new A2aJsonRpcClient(deps.http, `${base}/a2a/v1`);
      const [working, submitted, failed] = await Promise.all([
        client.listTasks("TASK_STATE_WORKING"),
        client.listTasks("TASK_STATE_SUBMITTED"),
        client.listTasks("TASK_STATE_FAILED", 1),
      ]);
      const lastFailed = failed[0];
      results.push({
        agent,
        up: true,
        detail: `${card.description}`,
        inFlight: working.length + submitted.length,
        ...(lastFailed !== undefined ? { lastError: taskText(lastFailed) } : {}),
      });
    } catch (err) {
      results.push({
        agent,
        up: false,
        detail: err instanceof Error ? err.message : String(err),
        inFlight: 0,
      });
    }
  }
  return results;
}

export function formatFleet(results: FleetAgentHealth[]): string[] {
  return results.map((r) => {
    const status = r.up ? "up  " : "DOWN";
    const inFlight = r.up ? ` in-flight:${r.inFlight}` : "";
    const lastError = r.lastError !== undefined ? ` last-error:"${r.lastError}"` : "";
    return `${status} ${r.agent}${inFlight}${lastError} — ${r.detail}`;
  });
}
