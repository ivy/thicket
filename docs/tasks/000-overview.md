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
| [016 Agent-initiated Slack reactions](016-agent-reactions.md) | 020, 026 | `apps/bridge` | typescript |
| [017 Bridge file surface](017-bridge-file-surface.md) | 009 | `apps/bridge` | typescript |
| [018 Materialize attachments into the agent's cache](018-attachment-materialization.md) | 017 | `packages/executor` | typescript |
| [019 Detect a Socket Mode connection that stops delivering](019-socket-liveness.md) | 009 | `apps/bridge` | typescript |
| [020 Agent Slack toolbelt](020-agent-slack-toolbelt.md) | 017 | `apps/agentd` | typescript |
| [021 Slack workspace knowledge](021-slack-workspace-tools.md) | 020 | `apps/bridge` | typescript |
| [022 Routines](022-routines.md) | 020, 021, 026 | `apps/agentd` | typescript |
| [023 Agent-to-agent delegation (research)](023-agent-delegation.md) | 020 | `.` | typescript |
| [024 Approvals](024-approvals.md) | 009 | `apps/bridge` | typescript |
| [025 Turn journal](025-turn-journal.md) | 008 | `apps/agentd` | typescript |
| [026 Agent persona](026-agent-persona.md) | 002 | `packages/roster` | typescript |
| [027 Provision the agent's workspace](027-provision-agent-workspace.md) | 010 | `apps/cli` | typescript |
| [028 thicket send](028-cli-send.md) | 011 | `apps/cli` | typescript |
| [029 thicket doctor must survive a failing probe](029-doctor-probe-isolation.md) | 010 | `apps/cli` | typescript |

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
| 7 | 015, 017 | 2 |
| 8 | 018 | 1 |
| 9 | 019, 025, 026, 029 | 4 |
| 10 | 020 | 1 |
| 11 | 016, 021 | 2 |
| 12 | 022 | 1 |

`005` and `006` are the hard ones and sit in the widest wave — start them first.
`003` is Go and shares no files with anything else.

Waves 9–12 are the current front. Take `019` first: it is the only known
defect, and a routine that fires into a quietly dead socket is worse than a
reply that arrives late. `026` and `025` are small and independent; `020` is
the substrate the rest of the Slack work stands on.

Everything in these waves is verifiable live — see
[LIVE-TESTING.md](LIVE-TESTING.md). Tasks still at `icebox` (023, 024, 027,
028) are parked for reasons written in each: a research task whose output
needs arguing with, a feature whose acceptance needs a human tapping a
button, and two that need a second host.


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
| `agents.sessions.setStatus` and `assistant.threads.setStatus` are complementary, not successive: the first drives the session lifecycle (`active`/`processing`/`suspended`/`closed`, the loading indicator and stop button), the second writes the prose line under the app's name. Only the latter's accepted *scope* is narrowing. | https://docs.slack.dev/reference/methods/agents.sessions.setStatus, https://docs.slack.dev/reference/methods/assistant.threads.setStatus |
| A message carrying an upload arrives subtyped `file_share`; `url_private_download` needs `files:read` and the bot token | https://docs.slack.dev/reference/methods/files.info |
| `chat.appendStream` takes either `markdown_text` or `chunks`, never both, and a stream that has carried a chunk rejects the top-level form | https://docs.slack.dev/reference/methods/chat.appendStream |
| Socket Mode removes the need for a public request URL | https://docs.slack.dev/apis/events-api/using-socket-mode |
| Free Slack plan caps installs at 10 apps | https://slack.com/help/articles/115002422943 |
| `tsnet.Server` exposes `AdvertiseTags`, `Dial`, `LocalClient().WhoIs` | https://pkg.go.dev/tailscale.com/tsnet |
| `@slack/socket-mode` detects a dead socket in seconds via its own ping loop, but reconnection fetches the wss URL through a WebClient whose default `retryConfig: {retries: 100, factor: 1.3}` retries invisibly and uncancellably for up to hours; bound it via `clientOptions.retryConfig` | `@slack/socket-mode@2.0.7` `dist/src/SocketModeClient.js`, `SlackWebSocket.js` |
| A `createSdkMcpServer` instance serves exactly one session: the second session to receive the same instance reports the server "failed to connect". Build a fresh instance per subprocess generation | observed live, `@anthropic-ai/claude-agent-sdk` 0.3.247 |
| `tailcfg.Node.Tags []string` carries peer tags | `tailcfg/tailcfg.go` |
