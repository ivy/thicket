# Reference

Runtime shape, the conventions every component follows, and facts about upstream
systems that were expensive to learn. The work queue itself lives in
[GitHub issues](https://github.com/ivy/thicket/issues).

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
| `@slack/socket-mode` detects a dead socket in seconds via its own ping loop, but reconnection fetches the wss URL through a WebClient whose default `retryConfig: {retries: 100, factor: 1.3}` retries invisibly and uncancellably for up to hours; bound it via `clientOptions.retryConfig`. Holds under Bun: with the bound in place a refused `apps.connections.open` surfaces to the supervisor in ~350ms, which then backs off visibly (1s, 5s, 15s, 60s) | `@slack/socket-mode@2.0.7` `dist/src/SocketModeClient.js`, `SlackWebSocket.js`; re-observed under Bun 1.4.0, 2026-08-29 |
| A `createSdkMcpServer` instance serves exactly one session: the second session to receive the same instance reports the server "failed to connect". Build a fresh instance per subprocess generation. Holds under Bun: two threads against one compiled agentd each drove the toolbelt | observed live, `@anthropic-ai/claude-agent-sdk` 0.3.247; re-observed under Bun 1.4.0, 2026-08-29 |
| `chat.startStream` requires `recipient_user_id` and `recipient_team_id` when streaming anywhere that is not a DM (`missing_recipient_team_id` otherwise); the team id comes from `auth.test` | https://docs.slack.dev/reference/methods/chat.startStream, observed live |
| `chat.postMessage` truncates text past 40,000 chars; guidance is ≤4,000 per message, and Slack may split longer ones itself at arbitrary points (observed: 4,692 chars became 3,610+1,081). A streamed message hits `msg_too_long` around ~3k chars of text plus cards | https://docs.slack.dev/reference/methods/chat.postMessage, rate-limits guide, observed live |
| Task-card icons are not emoji: the `icon` field takes `{"type":"icon","name":…}` from a fixed ~52-name set (code, globe, refine, file, edit, gear, bot, …) | https://docs.slack.dev/reference/block-kit/composition-objects/slack-icon-object |
| `chat.postMessage` `text` is parsed as mrkdwn (bold `*x*`, no `#` headings); real markdown goes in the separate `markdown_text` argument (12k cap, exclusive with `text`/`blocks`) — the dialect `chat.appendStream` chunks already use | https://docs.slack.dev/reference/methods/chat.postMessage, observed live |
| AskUserQuestion is offered to the model only when `canUseTool` is registered; a bare headless `query()` lists no such tool. With the callback present, a `PreToolUse` hook answering `permissionDecision: "defer"` ends the turn with `terminal_reason: tool_deferred` and `deferred_tool_use.input` carrying the full structured questions/options; the session's next send is the answer, and later questions defer again while the input stream stays open (a closed stream turns the deferral into a denial). Holds under Bun: the question came back as blocks and a typed answer resumed the same session | observed live, `@anthropic-ai/claude-agent-sdk` 0.3.247; re-observed under Bun 1.4.0, 2026-08-29 |
| `tailcfg.Node.Tags []string` carries peer tags | `tailcfg/tailcfg.go` |
| `actions/attest-build-provenance` refuses on a user-owned private repository: "Feature not available for user-owned private repositories. To enable this feature, please make this repository public." SLSA build provenance therefore waits on the public flip | observed, run 33239963963, 2026-08-29 |
| Creating a GitHub release attests it automatically — an `in-toto.io/attestation/release/v0.2` predicate naming the tag and every asset digest, initiated by `github` — even on a private repo with no build provenance. mise accepts it and prints "✓ GitHub artifact attestations verified", so that line alone does not prove a release was built by a workflow | observed, `gh api repos/ivy/thicket/attestations/sha256:…`, mise 2026.8.11, 2026-08-29 |
| Listing attestations is its own workflow permission: `contents: read` alone gets 403 "Resource not accessible by integration" from `/repos/{o}/{r}/attestations`, and mise fails the install rather than skipping verification. A job that installs a release needs `attestations: read` | observed, run 33240542607, 2026-08-29 |
| mise's asset autodetection scores os and arch tokens on word boundaries, so `<name>-<version>-<os>-<arch>.tar.gz` is enough: `linux-x64` and `macos-arm64` each picked their own archive with no `asset_pattern`. With no `bin_path` set, a `bin/` directory at the archive root is found and every executable in it lands on PATH | `src/backend/asset_matcher.rs`; observed on both platforms, 2026-08-29 |
| Bun cannot listen on a descriptor it did not open. `node:net` refuses with `EINVAL` ("Bun does not support listening on a file descriptor"); `node:http` resolves `listen({fd})`, reports success and then accepts nothing — a daemon that comes up mute. systemd socket activation therefore cannot work under Bun | observed, Bun 1.4.0, 2026-08-29 |
| A `bun build --compile` binary carries no `node_modules`, so `@anthropic-ai/claude-agent-sdk` cannot reach the per-platform CLI it ships as an optional dependency: the turn fails with "Native CLI binary for <platform> not found". Pass `pathToClaudeCodeExecutable` — the account's own `claude` is the right one | observed live, `@anthropic-ai/claude-agent-sdk` 0.3.247 under Bun 1.4.0, 2026-08-29 |
