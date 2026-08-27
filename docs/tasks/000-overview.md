---
id: "000"
title: Build plan overview
status: reference
---

# Build plan

Task files are `docs/tasks/<number>-<name>.md`. Each carries YAML frontmatter with its
status and dependencies. Work any task whose dependencies are all `done`.

## Frontmatter schema

```yaml
id: "005"                      # zero-padded, matches filename
title: Short imperative title
status: todo                   # todo | in-progress | blocked | done | icebox (parked; not picked up by the loop)
component: packages/executor   # path this task owns
language: typescript           # typescript | go | none
depends_on: ["002"]            # must be done before starting
blocks: ["008"]                # informational; derived from other tasks
parallel_safe: true            # false if it edits files another in-flight task owns
```

## Dependency graph

| Task | Depends on | Component | Lang |
|---|---|---|---|
| [001 Repository scaffold and toolchain](001-repo-scaffold.md) | — | `.` | none |
| [002 Roster schema and AgentCard generation](002-roster-and-cards.md) | 001 | `packages/roster` | typescript |
| [003 netd — tsnet transport shim](003-netd-tsnet-shim.md) | 001 | `netd` | go |
| [004 Durable A2A TaskStore](004-task-store.md) | 001 | `apps/agentd` | typescript |
| [005 Executor — Agent SDK stream to A2A task events](005-executor-translation.md) | 002 | `packages/executor` | typescript |
| [006 Session manager — hot/cold Claude Code sessions](006-session-manager.md) | 002 | `packages/executor` | typescript |
| [007 Slack app manifest renderer](007-slack-manifest-renderer.md) | 002 | `packages/slack-manifest` | typescript |
| [008 agentd — A2A server daemon](008-agentd.md) | 002, 004, 005, 006 | `apps/agentd` | typescript |
| [009 bridge — Slack Socket Mode to A2A](009-bridge.md) | 002 | `apps/bridge` | typescript |
| [010 CLI — provision and doctor](010-cli-provision.md) | 002, 007 | `apps/cli` | typescript |
| [011 CLI — MCP server for local Claude Code](011-cli-mcp.md) | 002 | `apps/cli` | typescript |
| [012 Deployment units and bootstrap](012-deploy-units.md) | 003, 008, 010 | `deploy` | none |
| [013 End-to-end integration and first agent](013-integration.md) | 008, 009, 011, 012, 014 | `.` | typescript |
| [014 Honor shouldQuery metadata end to end](014-shouldquery-metadata.md) | 005, 008, 009 | `packages/executor` | typescript |
| [015 Slack status fidelity and agent activity streaming](015-slack-status-fidelity.md) | 009 | `apps/bridge` | typescript |
| [016 Agent-initiated Slack reactions](016-agent-reactions.md) | 017 | `apps/bridge` | typescript |
| [017 Bridge file surface](017-bridge-file-surface.md) | 009 | `apps/bridge` | typescript |
| [018 Materialize attachments into the agent's cache](018-attachment-materialization.md) | 017 | `packages/executor` | typescript |
| [019 Detect a Socket Mode connection that stops delivering](019-socket-liveness.md) | 009 | `apps/bridge` | typescript |

Generated from task frontmatter; regenerate rather than hand-edit.

## Waves

Tasks in a wave have no dependencies on each other and can run concurrently.

| Wave | Tasks | Parallel |
|---|---|---|
| 1 | 001 | 1 |
| 2 | 002, 003, 004 | 3 |
| 3 | 005, 006, 007, 009, 011 | 5 |
| 4 | 008, 010 | 2 |
| 5 | 012, 014 | 2 |
| 6 | 013 | 1 |

`005` and `006` are the hard ones and sit in the widest wave — start them first.
`003` is Go and shares no files with anything else.


## Shared components

Two pairs of tasks own the same directory. They are dependency-independent, so the
graph allows them to run at once — coordinate the module boundary before starting, or
sequence them.

| Tasks | Shared path | Split |
|---|---|---|
| 005, 006 | `packages/executor` | 005 owns stream→event translation; 006 owns subprocess lifecycle. No shared files. |
| 010, 011 | `apps/cli` | Separate subcommands. 011 lands first (wave 3); if it is still open when 010 starts, agree on the shared A2A client module first. |

## Architecture summary

Enough context to work a task without reading every other file.

**Runtime topology.** One `agentd` per unix account, each fronted by a `netd` process
holding that agent's tailnet identity. `netd` terminates TLS on the tailnet and proxies
to `agentd` over a unix socket; `agentd` has no network listener. A single `bridge`
process holds one Slack Socket Mode connection per agent and acts as an A2A client.
Local Claude Code reaches the same agents through an MCP server that wraps the same A2A
client.

**Identity.** An agent is a `(host, unix user)` pair. Each gets a tailnet node tagged
`tag:thicket-<name>`, so ACLs express which agents may call which. Tags arrive at
`agentd` as a header that `netd` sets from a verified `WhoIs` lookup.

**Session model.** A Slack thread maps to an A2A `contextId`, not to a task. A2A tasks
are immutable and terminal, so each turn creates a new `Task` within the same context.
`contextId` is derived as `uuidv5(channel_id + ":" + thread_ts)` and doubles as the
Claude Agent SDK `sessionId`, so thread identity is computed rather than stored.

**Configuration.** `agents.yaml` in git is the source of truth. The provisioning CLI
renders it into Slack app manifests, per-account XDG config, and tailnet identities. At
run time there is no shared config: each agent serves its own `AgentCard`.

## Conventions

- Paths follow XDG. Config `~/.config/thicket/`, state `~/.local/state/thicket/`,
  runtime sockets `$XDG_RUNTIME_DIR/thicket/`. Nothing lives in `/etc`.
- systemd **user** units, named `thicket-<component>.service`. No `%i` templates —
  the unix user is the instance.
- Every generated artifact is reproducible from `agents.yaml`. If something must be
  hand-edited after generation, that is a bug in the generator.

## External references

Verified against upstream; re-check before assuming any of it drifted.

| Fact | Source |
|---|---|
| A2A `Task` is immutable once terminal; refinements start a new task in the same `contextId` | `docs/topics/life-of-a-task.md` in `a2aproject/A2A` |
| Agents use `contextId` to manage LLM context | same |
| `@a2a-js/sdk` v1.0.1 provides server, client, `TaskStore`, `AgentExecutor`, push notifications | npm |
| Slack agent sessions are app-scoped and keyed by `channel_id` + `thread_ts` | https://docs.slack.dev/ai/agent-sessions |
| `agents.sessions.setStatus` supersedes `assistant.threads.setStatus` | https://docs.slack.dev/ai/developing-agents |
| Socket Mode removes the need for a public request URL | https://docs.slack.dev/apis/events-api/using-socket-mode |
| Free Slack plan caps installs at 10 apps | https://slack.com/help/articles/115002422943 |
| `tsnet.Server` exposes `AdvertiseTags`, `Dial`, `LocalClient().WhoIs` | https://pkg.go.dev/tailscale.com/tsnet |
| `tailcfg.Node.Tags []string` carries peer tags | `tailcfg/tailcfg.go` |
