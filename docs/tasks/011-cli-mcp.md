---
id: "011"
title: CLI — MCP server for local Claude Code
status: done
component: apps/cli
language: typescript
depends_on: ["002"]
blocks: ["013"]
parallel_safe: true
---

# CLI — MCP server for local Claude Code

## Context

The A2A endpoint is the single front door; Slack is one client and local Claude Code is
another. `thicket mcp` is a stdio MCP server that exposes the fleet as tools, so a
session on the laptop can delegate to `hearth` or `ivy` the same way the bridge does —
same `contextId`, same session, same memory.

Independent of the bridge and of `agentd`; build it against a stub A2A server.

## Scope

**`thicket mcp`** — stdio MCP server, launched from Claude Code's MCP configuration.

Tools:

- `list_agents` — returns each agent's name, description, and skills, sourced from
  fetched agent cards rather than local config, so it reflects live capability.
- `ask_agent(agent, message, context_id?)` — sends via A2A, returns the result.
  Streams progress where the transport allows.
- `agent_task_status(task_id)` — for long-running work.

**Routing.** Outbound A2A calls go through `netd`'s egress socket so the call carries a
tailnet identity subject to ACLs, rather than the host's identity.

**Discovery.** Fetch cards on demand and honor `Cache-Control` / `ETag` per A2A §8.6,
with conditional requests on expiry. A skill added to an agent should appear here
without restarting anything.

**Context.** When invoked with a `context_id`, continue that conversation — this is what
lets work started in Slack be picked up locally.

## Acceptance criteria

- [x] Claude Code lists the tools when the server is configured in its MCP settings.
- [x] `list_agents` reflects a skill added to an agent's card without restarting the
      MCP server, once the cache expires.
- [x] `ask_agent` against a live agent returns its response.
- [x] A conversation started in Slack can be continued by passing its `context_id`, and
      the agent recalls the earlier turns.
- [x] Calls route through the egress socket; an agent the caller's tag may not reach
      fails with a clear authorization error, not a timeout.
- [x] An unreachable agent returns a useful error promptly rather than hanging.
- [x] Card fetches issue conditional requests and handle 304.

## Out of scope

Slack. Running agents locally — this is a client only.
