# Handoff: thicket live Slack testing — first agent (hearth) working end to end

## Mission
Build and live-test **thicket**: a fleet of Claude Code agents, each a `(host, unix
user)` pair behind an A2A endpoint, bridged to Slack (one app per agent) and to local
Claude Code via MCP. All 14 build tasks (`docs/tasks/`) are done except 013
(blocked on real Linux/systemd + tailnet deployment) and 015 (icebox). We are now in
interactive live testing on this Mac with the operator (Ivy), fixing real-world bugs
as they surface — 8 found and fixed so far in this phase.

## State
- **Cwd:** `/Users/ivy/src/github.com/ivy/a2a-slack`
- **Branch:** `main` (local only — NEVER push, no remotes)
- **Uncommitted:** clean (except this HANDOFF.md)
- **Last commit:** `1a021d1 — feat(roster,executor): permissionMode per harness, defaulting to auto`

## Live test stack (RUNNING right now, survives compaction)
Local rig in `~/thicket-test/` (env: `XDG_CONFIG_HOME=~/thicket-test/config`,
`XDG_STATE_HOME=~/thicket-test/state`, `XDG_RUNTIME_DIR=~/thicket-test/run`):
- **agentd** pid in `~/thicket-test/agentd.pid`, unix socket
  `~/thicket-test/run/thicket/agentd.sock`, log `~/thicket-test/agentd.log`
- **netd stand-in** (dev proxy, stamps `x-thicket-peer-tags: tag:thicket-bridge`)
  pid `~/thicket-test/proxy.pid`, listens `127.0.0.1:8791`, source
  `~/thicket-test/netd-stand-in.mjs`
- **bridge** pid `~/thicket-test/bridge.pid`, connected to Slack Socket Mode,
  started with `THICKET_BRIDGE_ENDPOINTS='{"hearth":"http://127.0.0.1:8791"}'`,
  log `~/thicket-test/bridge.log`
- Slack app **hearth = A0BSWSABK37**, installed to ivyevans.slack.com; DM channel
  `D0BT2RF1G9F`. Secrets (never print/commit): `~/thicket-test/config/thicket/
  slack-config-token.json` (app config token pair, auto-rotated by CLI) and
  `bridge.json` (xapp-/xoxb- tokens), both 0600.
- Restart pattern (after rebuilding): kill pid from pidfile, then
  `nohup mise exec -- node /Users/ivy/src/github.com/ivy/a2a-slack/apps/agentd/dist/bin.js`
  with the XDG env above; same shape for bridge (plus THICKET_BRIDGE_ENDPOINTS).
  **Always `cd` to repo root first — Bash cwd persists across calls and has bitten twice.**

## Done (this live-test phase; all committed, each with tests)
- Local A2A smoke test over unix socket with a **real Claude session** (recall works).
- `getSessionInfo` resolves `undefined` for missing sessions (not throw) → resume
  bug fixed (`packages/executor/src/session-manager.ts` defaultSessionExists).
- macOS keychain needs `USER`/`LOGNAME` in session env → added to default env.
- Slack admin API: token must be Authorization header (not JSON body);
  `agent_view.actions` are `{name, description}` objects; description cap is ~120
  not documented 140; `apps.manifest.export` omits server-defaults AND write-only
  fields → drift = projection + sha256 fingerprint of last push
  (`apps/cli/src/provision.ts`, `slack-admin.ts`).
- Install link: use `https://api.slack.com/apps/<ID>/install-on-team`, not
  oauth_authorize_url (needs redirect URL we don't have).
- DM composer was disabled → manifest now always sets
  `features.app_home.messages_tab_enabled: true`.
- **Fold-race fix**: second rapid DM was mis-folded into turn 1 (stale
  `queued_turn_count` census) and its answer dropped. Now sends registered after a
  turn opens are never fold-eligible for it (`packages/executor/src/translator.ts`
  takeFolded/openSeq). Verified live: two rapid DMs → two answers.
- `permissionMode` per roster harness (default **auto**; bypassPermissions
  deliberately excluded), plumbed roster → SessionManager → query options.
  agentd restarted with it at 04:02Z.

## In progress
- **Awaiting Ivy's retest**: re-ask hearth the administrative/system question
  (`vm_stat`/`top`/`sysctl` were headless-denied before the permissionMode change).
  Expect the auto classifier to approve read-only diagnostics. Check
  `~/thicket-test/state/thicket/agentd/tasks.db` (node:sqlite, table `tasks`,
  `task_json` column) for the reply text; bridge/agentd logs are silent on success.

## Next steps
1. Confirm auto-mode retest result with Ivy; if classifier still denies, inspect
   the result's `permission_denials` in the task JSON.
2. Remaining live scenarios: stop button mid-task (`session_stopped` → CancelTask),
   `thicket mcp` against the live agentd (context continuity from the Slack thread),
   `thicket fleet` / `doctor` against the live rig.
3. Task 013 stays `blocked` until real deployment (Linux+systemd host, tailnet tag
   authority, per `docs/tasks/013-integration.md` Blocked section). Task 015
   (Slack status fidelity: agents.sessions.setStatus vs assistant.threads.setStatus,
   + reactions-MCP idea) is `icebox` — do not pick up unless promoted.
4. Teardown when asked: kill three pids, optionally `rm -rf ~/thicket-test` —
   but the Slack app A0BSWSABK37 and its tokens persist regardless.

## Decisions made
- **Ralph-loop protocol still governs repo work**: PROMPT.md — one task at a time,
  local commits only, never push, check acceptance boxes only on observation.
- **Secrets never enter the transcript**: operator writes token files in her own
  terminal; agent validates shape/mode only.
- **Bridge card-URL pinning**: A2A client dials its configured base URL, not the
  card's advertised host (prod no-op, dev necessity) — `apps/bridge/src/a2a-client.ts`.
- **Write-only manifest fields can't be drift-checked** → fingerprint of last push
  in provision-state.json decides desired-side updates exactly once.
- **Icebox status exists** (`docs/tasks/000-overview.md` schema comment): loop
  ignores it.

## Don't redo
- Don't "fix" coalescing by trusting `queued_turn_count` alone — it's a stale
  census; the turn-boundary eligibility rule is the sound fix (see 4a34050).
- Don't use `kill %1` across Bash tool calls (jobs don't persist); use the pidfiles.
- Don't put the token in a Slack API JSON body (not_authed) or use
  oauth_authorize_url for installs.
- Don't run `pnpm lint`/`test` from a package dir — root only (scripts differ).

## Key files
- `docs/tasks/000-overview.md` — task board; 013 blocked, 015 icebox, rest done.
- `packages/executor/src/translator.ts` — stream→A2A core; fold logic (openSeq).
- `packages/executor/src/session-manager.ts` — hot/cold pool, env, permissionMode.
- `apps/cli/src/provision.ts` — drift projection + fingerprint; `slack-admin.ts` API quirks.
- `apps/bridge/src/engine.ts` — status mapping w/ deferred release (turnsOpen).
- `tests/integration/src/` — real-stack scenario tests (run via
  `cd tests/integration && mise exec -- node --test dist/scenarios.test.js`).
- `docs/runbook.md`, `deploy/README.md` — ops docs, used during live bring-up.

## Useful commands
- `mise exec -- pnpm build && mise exec -- pnpm test && mise exec -- pnpm lint` — from repo root; all 7 workspace members must show `# fail 0`.
- `XDG_CONFIG_HOME=~/thicket-test/config mise exec -- node apps/cli/dist/bin.js provision` — idempotent; "up to date" expected.
- `curl -s --unix-socket ~/thicket-test/run/thicket/agentd.sock http://x/.well-known/agent-card.json` — agentd liveness.
- Task-store peek: `mise exec -- node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.env.HOME+'/thicket-test/state/thicket/agentd/tasks.db'); for (const r of db.prepare('SELECT id,state,status_timestamp,task_json FROM tasks ORDER BY rowid DESC LIMIT 3').all()) console.log(r.state, r.id.slice(0,8), JSON.parse(r.task_json).status?.message?.parts?.map(p=>p.text).join('').slice(0,120)); db.close()"`
- Git commits end with `Claude-Session: https://claude.ai/code/session_014ihTUtFhf3McYeLcQxea8Q`.
