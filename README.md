# thicket

A fleet of AI agents that live on the systems you operate, reachable from Slack or
from Claude Code, and able to collaborate with each other.

Each agent is a Claude Code session bound to one unix account on one host. It speaks
[A2A](https://a2a-protocol.org) over your tailnet and appears in Slack as its own app
with a native agent surface. Adding an agent is a config change plus a provisioning run.

This is one operator's fleet, built in the open. Issues and questions are welcome;
the [roadmap](docs/roadmap.md) is the operator's, and [docs/vision.md](docs/vision.md)
is the argument behind it.

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
| `apps/cli/` | TypeScript | `provision`, `doctor`, `fleet`, `journal`, `mcp`, `slack-test-mcp` |
| `packages/roster/` | TypeScript | `agents.yaml` → `AgentCard`; the shared contract |
| `packages/executor/` | TypeScript | Agent SDK message stream → A2A task events |
| `packages/slack-manifest/` | TypeScript | `AgentCard` → Slack app manifest |
| `deploy/` | — | systemd user units, launchd plists, and a local dev rig |
| `tests/integration/` | TypeScript | real agentd + real bridge over HTTP; only Slack is faked |

## Status

Running, for one operator: the Slack surface — DMs, mentions, threads, streamed
answers with a step timeline, attachments, questions with buttons, reactions,
routines and one-shot schedules — works end to end on a single host. Real
multi-host deployment (systemd, tailnet identity) is the next arc; see the
[roadmap](docs/roadmap.md).

Work is decomposed in [docs/tasks/](docs/tasks/) as a dependency graph —
[docs/tasks/000-overview.md](docs/tasks/000-overview.md) has the build order and the
hard-won facts about the APIs involved. [AGENTS.md](AGENTS.md) is the map for anyone
(or any agent) working in the repo.

## Requirements

- The toolchain pinned in [mise.toml](mise.toml): Node, Go, and pnpm
- A Tailscale tailnet with ACL tags you control
- A Slack workspace (one app per agent; the free plan caps installs at 10)
- An Anthropic API key or a Claude Code OAuth token per agent account

## License

[ISC](LICENSE).
