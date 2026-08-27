---
id: "013"
title: End-to-end integration and first agent
status: blocked
component: .
language: typescript
depends_on: ["008", "009", "011", "012"]
blocks: []
parallel_safe: false
---

# End-to-end integration and first agent

## Context

Everything up to here is unit-tested in isolation. This task proves the seams: Slack to
bridge to tailnet to `netd` to `agentd` to a Claude Code session and back, plus the
local Claude Code path to the same session.

Deploy one real agent. Resist adding the rest until this one is boring.

## Scope

**Deploy `hearth`** — the lowest-privilege agent, so early mistakes are cheap.

**End-to-end scenarios**, each verified by hand and then captured as an automated test
where feasible:

1. DM the agent in Slack; get a response. Session status goes `processing` → `active`.
2. Send three messages rapidly; observe coalescing and that the status stays
   `processing` until the queue drains.
3. Start a long task, press stop; the task reaches `canceled` and the agent stops.
4. Continue the same conversation from Claude Code via `thicket mcp` with the thread's
   `context_id`; the agent recalls the Slack turns.
5. Stop `thicket-agentd`, send a Slack message; get an honest in-thread notice. Restart;
   the queued message is delivered.
6. Restart `agentd` mid-task; the task ends `failed` with a restart message rather than
   hanging.
7. From an agent account whose tag lacks permission, attempt to reach `hearth`; the call
   is refused at the network layer.

**Observability.** A single command that shows fleet health: which agents are up, live
sessions, in-flight tasks, last error per agent. `doctor` may host this.

**Runbook.** `docs/runbook.md` covering: an agent stops responding, Socket Mode will not
reconnect, tailnet auth key expired, a session is wedged, tasks stuck in `working`.

## Acceptance criteria

- [ ] All seven scenarios pass against a real deployment. (Blocked: see below.)
- [x] Scenarios 1, 2, 3, and 6 have automated tests against a mock Slack and a real
      `agentd` — real store, executor, session pool, and HTTP surface, with the
      bridge speaking actual A2A over the wire (`tests/integration`). Stable
      across repeated runs.
- [ ] Scenario 7 is verified against real tailnet ACLs, not a mock. (Blocked:
      requires a live tailnet; the agentd-level tag rejection and netd's
      WhoIs-stamping are covered by tasks 008 and 003.)
- [x] Fleet health command (`thicket fleet`) reports accurately with an agent
      deliberately stopped: up/down, in-flight counts, last error.
- [x] Runbook entries each name a symptom, a diagnostic command, and a fix
      (`docs/runbook.md`).
- [x] No code changes are needed for a second agent: the automated test derives
      card, manifest, and a running daemon for a fresh roster entry using only
      generators. The live `provision` + bootstrap walk for agent two happens
      with the deployment below.

## Out of scope

Adding the remaining agents. Any capability work inside an agent — that is skills and
`CLAUDE.md` in its account, not code in this repo.

## Blocked

Everything verifiable without leaving this repository is done and automated;
what remains requires infrastructure and credentials only the operator holds:

- a Linux host with systemd for the agent accounts (plus the always-on bridge
  account), reachable per `deploy/README.md`;
- a tailscale account with `tag:thicket-*` tag owners configured and authority
  to mint tagged auth keys (verifies scenario 7 against real ACLs, plus task
  003's live `*.ts.net` TLS criterion);
- a Slack workspace with an app configuration token (real apps, real Socket
  Mode, real agent surface);
- Anthropic credentials in each agent account for real Claude Code sessions.

Unblock by walking `deploy/README.md` for `hearth`, then running the seven
scenarios from this file by hand, `thicket doctor` and `thicket fleet` against
the live fleet, and the live-host checks deferred from tasks 003 and 012.
Already tried: every scenario that can run against in-process infrastructure
runs in `tests/integration` (scenarios 1, 2, 3, 6, fleet health, second-agent
derivation), which also flushed out and fixed two real cross-stream races in
the bridge's session-status handling and a coalescing acknowledgment gap in
the executor.
