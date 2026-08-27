import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Roster } from "@thicket/roster";
import { agentUrl } from "@thicket/roster";

import { A2aJsonRpcClient } from "./a2a.js";
import { CardCache } from "./card-cache.js";
import type { HttpDoer } from "./http.js";

export interface McpDeps {
  roster: Roster;
  http: HttpDoer;
  tailnetDomain?: string;
  now?: () => number;
  /**
   * Per-agent base-URL overrides (agent -> "http://host:port"), replacing
   * the tailnet-derived URL. Used by tests and unusual deployments.
   */
  endpointOverrides?: Record<string, string>;
}

interface AgentEndpoints {
  cardUrl: string;
  rpcUrl: string;
}

function endpointsFor(deps: McpDeps, agent: string): AgentEndpoints {
  const entry = deps.roster.agents[agent];
  if (entry === undefined) {
    throw new Error(
      `unknown agent "${agent}"; roster has: ${Object.keys(deps.roster.agents).join(", ")}`,
    );
  }
  const override = deps.endpointOverrides?.[agent];
  const base =
    override ?? agentUrl(entry, { tailnetDomain: deps.tailnetDomain }).replace(/\/a2a\/v1$/, "");
  return { cardUrl: `${base}/.well-known/agent-card.json`, rpcUrl: `${base}/a2a/v1` };
}

/**
 * The fleet as MCP tools. A local Claude Code session delegates to agents
 * through the same A2A front door the bridge uses — same contextId, same
 * session, same memory — with outbound calls routed by the injected
 * HttpDoer (netd's egress socket in production).
 */
export function buildMcpServer(deps: McpDeps): McpServer {
  const cache = new CardCache(deps.http, deps.now);
  const clientFor = (agent: string) =>
    new A2aJsonRpcClient(deps.http, endpointsFor(deps, agent).rpcUrl);

  const server = new McpServer({ name: "thicket", version: "0.1.0" });

  server.registerTool(
    "list_agents",
    {
      description:
        "List the thicket fleet: each agent's name, description, and current " +
        "skills, from live agent cards (not local config).",
      inputSchema: {},
    },
    async () => {
      const lines: string[] = [];
      for (const agent of Object.keys(deps.roster.agents)) {
        const { cardUrl } = endpointsFor(deps, agent);
        try {
          const card = await cache.get(agent, cardUrl);
          const skills = card.skills
            .map((skill) => `${skill.name}: ${skill.description}`)
            .join("; ");
          lines.push(`${agent} — ${card.description}${skills === "" ? "" : ` [skills: ${skills}]`}`);
        } catch (err) {
          lines.push(
            `${agent} — unreachable (${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "ask_agent",
    {
      description:
        "Send a message to a thicket agent over A2A and return its reply. " +
        "Pass context_id to continue an existing conversation (for example " +
        "one started in Slack); omit it to start fresh. The reply includes " +
        "the context_id to reuse.",
      inputSchema: {
        agent: z.string().describe("agent name from list_agents"),
        message: z.string().describe("what to ask or tell the agent"),
        context_id: z
          .string()
          .optional()
          .describe("conversation to continue; omit to start a new one"),
      },
    },
    async ({ agent, message, context_id }) => {
      try {
        const result = await clientFor(agent).ask(message, context_id);
        return {
          content: [
            {
              type: "text",
              text:
                `${result.text}\n\n` +
                `[task_id: ${result.taskId} | context_id: ${result.contextId} | state: ${result.state}]`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            { type: "text", text: err instanceof Error ? err.message : String(err) },
          ],
        };
      }
    },
  );

  server.registerTool(
    "agent_task_status",
    {
      description: "Check a long-running thicket task by id.",
      inputSchema: {
        agent: z.string().describe("agent name the task belongs to"),
        task_id: z.string().describe("task id returned by ask_agent"),
      },
    },
    async ({ agent, task_id }) => {
      try {
        const result = await clientFor(agent).taskStatus(task_id);
        return {
          content: [
            {
              type: "text",
              text: `${result.state}${result.text === "" ? "" : `\n${result.text}`}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            { type: "text", text: err instanceof Error ? err.message : String(err) },
          ],
        };
      }
    },
  );

  return server;
}
