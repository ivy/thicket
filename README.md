# thicket

A fleet of AI agents that live on the systems you operate, reachable from Slack or
from Claude Code, and able to collaborate with each other.

Each agent is a Claude Code session bound to one unix account on one host. It speaks
[A2A](https://a2a-protocol.org) over your tailnet and appears in Slack as its own app
with a native agent surface. Adding an agent is a config change plus a provisioning run.

```
Slack ──► bridge ──┐
                   ├──► A2A ──► agentd (per unix account) ──► Claude Code session
Claude Code ───────┘                                          via Agent SDK
   (MCP)
```

## Why it is shaped this way

An agent's identity is a `(host, unix user)` pair, because that is the boundary that
actually constrains what it can touch. Specialization comes from skills and `CLAUDE.md`
inside that account, not from separate agent identities. Agents that ingest untrusted
content (email, torrents, the web) run in accounts that cannot reach accounts holding
privilege, and Tailscale ACLs enforce that at the network layer.

See [docs/vision.md](docs/vision.md) for the full rationale.

## Components

| Path | Language | Role |
|---|---|---|
| `netd/` | Go | tsnet node per agent; tailnet ⇄ unix socket, injects verified peer tags |
| `apps/agentd/` | TypeScript | A2A server + Claude Code session manager (hot/cold) |
| `apps/bridge/` | TypeScript | Slack Socket Mode ⇄ A2A client; thread ⇄ session mapping |
| `apps/cli/` | TypeScript | `provision`, `doctor`, `mcp` |
| `packages/roster/` | TypeScript | `agents.yaml` → `AgentCard`; the shared contract |
| `packages/executor/` | TypeScript | Agent SDK message stream → A2A task events |
| `packages/slack-manifest/` | TypeScript | `AgentCard` → Slack app manifest |
| `deploy/` | — | systemd user units, launchd plists |

## Status

Not yet implemented. Work is decomposed in [docs/tasks/](docs/tasks/) as a dependency
graph — see [docs/tasks/000-overview.md](docs/tasks/000-overview.md) for the build order
and what can proceed in parallel.

## Requirements

- Node 18+ and Go 1.22+
- A Tailscale tailnet with ACL tags you control
- A Slack workspace (one app per agent; the free plan caps installs at 10)
- An Anthropic API key or an authenticated `ant` profile per agent account
