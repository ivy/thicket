---
id: "000"
title: Build plan overview
status: reference
---

# Build plan

Task files are `docs/tasks/<number>-<name>.md`. Each carries YAML frontmatter with its
status and dependencies. Work any task whose dependencies are all `done`.

Finished tasks are archived: a task that reaches `status: done` moves to
`docs/tasks/archived/`, frontmatter intact. A `depends_on` entry with no file left in
`docs/tasks/` is therefore satisfied. New task numbers continue from the highest number
ever used, archive included — numbers are never reused.

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
| [001 Repository scaffold and toolchain](archived/001-repo-scaffold.md) | — | `.` | none |
| [002 Roster schema and AgentCard generation](archived/002-roster-and-cards.md) | 001 | `packages/roster` | typescript |
| [003 netd — tsnet transport shim](archived/003-netd-tsnet-shim.md) | 001 | `netd` | go |
| [004 Durable A2A TaskStore](archived/004-task-store.md) | 001 | `apps/agentd` | typescript |
| [005 Executor — Agent SDK stream to A2A task events](archived/005-executor-translation.md) | 002 | `packages/executor` | typescript |
| [006 Session manager — hot/cold Claude Code sessions](archived/006-session-manager.md) | 002 | `packages/executor` | typescript |
| [007 Slack app manifest renderer](archived/007-slack-manifest-renderer.md) | 002 | `packages/slack-manifest` | typescript |
| [008 agentd — A2A server daemon](archived/008-agentd.md) | 002, 004, 005, 006 | `apps/agentd` | typescript |
| [009 bridge — Slack Socket Mode to A2A](archived/009-bridge.md) | 002 | `apps/bridge` | typescript |
| [010 CLI — provision and doctor](archived/010-cli-provision.md) | 002, 007 | `apps/cli` | typescript |
| [011 CLI — MCP server for local Claude Code](archived/011-cli-mcp.md) | 002 | `apps/cli` | typescript |
| [012 Deployment units and bootstrap](archived/012-deploy-units.md) | 003, 008, 010 | `deploy` | none |
| [013 End-to-end integration and first agent](013-integration.md) | 008, 009, 011, 012, 014 | `.` | typescript |
| [014 Honor shouldQuery metadata end to end](archived/014-shouldquery-metadata.md) | 005, 008, 009 | `packages/executor` | typescript |
| [015 Slack status fidelity and agent activity streaming](archived/015-slack-status-fidelity.md) | 009 | `apps/bridge` | typescript |
| [016 Agent-initiated Slack reactions](archived/016-agent-reactions.md) | 020, 026 | `apps/bridge` | typescript |
| [017 Bridge file surface](archived/017-bridge-file-surface.md) | 009 | `apps/bridge` | typescript |
| [018 Materialize attachments into the agent's cache](archived/018-attachment-materialization.md) | 017 | `packages/executor` | typescript |
| [019 Detect a Socket Mode connection that stops delivering](archived/019-socket-liveness.md) | 009 | `apps/bridge` | typescript |
| [020 Agent Slack toolbelt](archived/020-agent-slack-toolbelt.md) | 017 | `apps/agentd` | typescript |
| [021 Slack workspace knowledge](archived/021-slack-workspace-tools.md) | 020 | `apps/bridge` | typescript |
| [022 Routines](archived/022-routines.md) | 020, 021, 026 | `apps/agentd` | typescript |
| [023 Agent-to-agent delegation (research)](023-agent-delegation.md) | 020 | `.` | typescript |
| [024 Approvals](024-approvals.md) | 009 | `apps/bridge` | typescript |
| [025 Turn journal](archived/025-turn-journal.md) | 008 | `apps/agentd` | typescript |
| [026 Agent persona](archived/026-agent-persona.md) | 002 | `packages/roster` | typescript |
| [027 Provision the agent's workspace](027-provision-agent-workspace.md) | 010 | `apps/cli` | typescript |
| [028 thicket send](028-cli-send.md) | 011 | `apps/cli` | typescript |
| [029 thicket doctor must survive a failing probe](archived/029-doctor-probe-isolation.md) | 010 | `apps/cli` | typescript |
| [030 Executor attachment tests flake under the workspace test run](archived/030-executor-test-flake.md) | 018 | `packages/executor` | typescript |
| [031 Canvas read](031-canvas-read.md) | 021 | `apps/bridge` | typescript |
| [032 A mention in a channel fails at chat.startStream](archived/032-channel-streaming.md) | 015 | `apps/bridge` | typescript |
| [033 doctor's card check never gets the roster it needs](archived/033-doctor-card-roster-wiring.md) | 010 | `apps/cli` | typescript |
| [034 Split long replies at boundaries the reader can live with](archived/034-message-length-splitting.md) | 032 | `apps/bridge` | typescript |
| [035 Task cards carry an icon that says what kind of step this is](archived/035-task-card-icons.md) | 015 | `packages/executor` | typescript |
| [036 Fallback posts speak markdown, like the stream they stand in for](archived/036-fallback-markdown-dialect.md) | 032 | `apps/bridge` | typescript |
| [037 Agent questions render as Slack UI, and a tap answers them](037-agent-questions-ui.md) | 014, 015 | `apps/bridge` | typescript |
| [038 One-shot scheduled prompts](038-one-shot-schedule.md) | 022 | `apps/agentd` | typescript |
| [039 Open the repo — ISC license, README, and a clean history](039-open-source-readiness.md) | — | `.` | none |
| [040 Bun port — one runtime, standalone executables](040-bun-port.md) | 013 | `.` | typescript |
| [041 Release pipeline — a tag becomes attested artifacts](041-release-pipeline.md) | 039, 040 | `.` | none |
| [042 thicket install — the last mile after mise](042-cli-install.md) | 041 | `apps/cli` | typescript |
| [043 Project channels know their workspace](043-channel-workspace-binding.md) | 006, 009, 044 | `apps/bridge` | typescript |
| [044 The agent knows which Slack thread it is in](044-agent-knows-its-thread.md) | 005, 009, 020 | `packages/executor` | typescript |

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
| 9 | 019, 025, 026, 029, 030, 032, 033 | 7 |
| 10 | 020 | 1 |
| 11 | 016, 021 | 2 |
| 12 | 022, 031 | 2 |
| 13 | 034, 035, 036, 037, 038, 044 | 6 |
| 14 | 039, 040, 043 | 3 |
| 15 | 041 | 1 |
| 16 | 042 | 1 |

Waves 13 and 14 are the current front: `037`, `038`, and `044` close out the
Slack surface ([roadmap](../roadmap.md) Arc 1) while `039`–`043` open the
deployment arc.

Everything in these waves is verifiable live — see
[LIVE-TESTING.md](LIVE-TESTING.md). Tasks still at `icebox` (023, 024, 027,
028) are parked for reasons written in each: a research task whose output
needs arguing with, a feature whose acceptance needs a human tapping a
button, and two that need a second host.

Waves 14–16 are the deployment arc ([roadmap](../roadmap.md) Arc 2). 039,
040, and 043 are independent openers — but 040 touches the whole toolchain,
so don't run it concurrently with anything, and 043 waits on 044 for the
thread coordinates it builds on. 041 chains behind the first two, 042
behind 041.


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
| `chat.startStream` requires `recipient_user_id` and `recipient_team_id` when streaming anywhere that is not a DM (`missing_recipient_team_id` otherwise); the team id comes from `auth.test` | https://docs.slack.dev/reference/methods/chat.startStream, observed live |
| `chat.postMessage` truncates text past 40,000 chars; guidance is ≤4,000 per message, and Slack may split longer ones itself at arbitrary points (observed: 4,692 chars became 3,610+1,081). A streamed message hits `msg_too_long` around ~3k chars of text plus cards | https://docs.slack.dev/reference/methods/chat.postMessage, rate-limits guide, observed live |
| Task-card icons are not emoji: the `icon` field takes `{"type":"icon","name":…}` from a fixed ~52-name set (code, globe, refine, file, edit, gear, bot, …) | https://docs.slack.dev/reference/block-kit/composition-objects/slack-icon-object |
| `chat.postMessage` `text` is parsed as mrkdwn (bold `*x*`, no `#` headings); real markdown goes in the separate `markdown_text` argument (12k cap, exclusive with `text`/`blocks`) — the dialect `chat.appendStream` chunks already use | https://docs.slack.dev/reference/methods/chat.postMessage, observed live |
| AskUserQuestion is offered to the model only when `canUseTool` is registered; a bare headless `query()` lists no such tool. With the callback present, a `PreToolUse` hook answering `permissionDecision: "defer"` ends the turn with `terminal_reason: tool_deferred` and `deferred_tool_use.input` carrying the full structured questions/options; the session's next send is the answer, and later questions defer again while the input stream stays open (a closed stream turns the deferral into a denial) | observed live, `@anthropic-ai/claude-agent-sdk` 0.3.247 |
| `tailcfg.Node.Tags []string` carries peer tags | `tailcfg/tailcfg.go` |
