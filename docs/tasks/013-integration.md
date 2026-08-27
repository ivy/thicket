---
id: "013"
title: End-to-end integration and first agent
status: todo
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

- [ ] All seven scenarios pass against a real deployment.
- [ ] Scenarios 1, 2, 3, and 6 have automated tests against a mock Slack and a real
      `agentd`.
- [ ] Scenario 7 is verified against real tailnet ACLs, not a mock.
- [ ] Fleet health command reports accurately with an agent deliberately stopped.
- [ ] Runbook entries each name a symptom, a diagnostic command, and a fix.
- [ ] A second agent can be added by editing `agents.yaml` and running `provision` plus
      the bootstrap steps — no code changes.

## Out of scope

Adding the remaining agents. Any capability work inside an agent — that is skills and
`CLAUDE.md` in its account, not code in this repo.
