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
| `apps/cli/` | TypeScript | `provision`, `doctor`, `fleet`, `journal`, `mcp` |
| `packages/roster/` | TypeScript | `agents.yaml` → `AgentCard`; the shared contract |
| `packages/executor/` | TypeScript | Agent SDK message stream → A2A task events |
| `packages/slack-manifest/` | TypeScript | `AgentCard` → Slack app manifest |
| `deploy/` | — | systemd user units, launchd plists |

## Status

Running. One agent answers from Slack and from Claude Code, with the whole path —
Socket Mode, A2A, session manager, task store — live end to end. 29 of 43 tasks are
done; what is left is the Slack surface (questions, schedules), first deployment to a
second host, and the release pipeline. Four are parked in the icebox.

Real deployment is still ahead of the tooling in places: `netd` wants a tailnet you
administer, and there is no installer yet, so an agent host needs a checkout. The
laptop rig in [deploy/dev/](deploy/dev/) stands in for netd where there is no tailnet.

[docs/roadmap.md](docs/roadmap.md) is the arc order;
[docs/tasks/000-overview.md](docs/tasks/000-overview.md) is the dependency graph and
the current wave.

## Requirements

- Node 22+ and Go 1.27+ — both pinned in `mise.toml`. Node 22 is a floor, not a
  preference: the task store and the bridge's state both use `node:sqlite`.
- A Tailscale tailnet with ACL tags you control, and tag owners for `tag:thicket-*`
- A Slack workspace where you can create apps, and an
  [app configuration token](https://api.slack.com/authentication/config-tokens).
  One app per agent, and the free plan caps installs at 10.
- Claude Code authenticated in each agent's unix account. Sessions inherit that
  account's own credentials; anything else they need is named in `env_passthrough`
  in the account's `agentd.json`.
