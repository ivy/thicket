---
id: "025"
title: Turn journal — what happened, what it cost
status: done
component: apps/agentd
language: typescript
depends_on: ["008"]
blocks: []
parallel_safe: true
---

# Turn journal

## Context

Every result frame carries `total_cost_usd`, token usage, duration, and
`permission_denials`, and all of it is discarded the moment the turn ends.
The task store keeps the A2A task; nothing keeps the accounting.

Three separate wants turn out to be the same record:

- **Cost.** The Anthropic console gives a total, not a breakdown. Which agent,
  which thread, which routine — none of that is answerable today.
- **Routine debugging** (task 022). Scheduled work fails quietly, and a
  routine designed to stay silent when it has nothing to say is
  indistinguishable from one that has been broken for a week. The run record
  is what separates them.
- **Audit.** Which agent ran what, when, and whether anything was denied.

One durable per-turn record answers all three. Building three narrower
mechanisms would not.

## Scope

- A row per turn: agent, context, thread, what triggered it (human, routine,
  delegation), tools used, tokens, cost, duration, terminal state, permission
  denials, error.
- **Metadata only — no prompt or reply text.** Decided: capturing them would
  turn the journal into a plaintext record of everything every agent has ever
  been told, sitting on disk forever, to buy debugging convenience that the
  Claude Code session transcript already provides. Do not add a flag for it.
- Durable and local, alongside the task store — same lifecycle, same account,
  no service to run.
- Queryable from the CLI: cost by agent over a window, recent failures,
  a routine's run history.
- Retention. This grows forever otherwise; the pruning that already exists for
  terminal tasks is the model.

## Open questions

- Whether the bridge needs its own view, or the CLI reading each agent's
  journal over A2A is enough. The latter avoids a second store.

## Acceptance criteria

- [x] Every turn leaves a record, including ones that produced no output.
- [x] Cost is answerable per agent and per time window from the CLI.
- [x] A routine's history is inspectable without reading raw logs.
- [x] The journal is bounded without operator intervention.

## What was built, and what verification established (2026-08-27)

The accounting seam lives in the translator (`onTurnResult`), because that
is the only place that sees both the result frame and which send the turn
answered. One subtlety mattered: the SDK's `total_cost_usd` and `usage`
are **running totals per subprocess generation**, so the translator
baselines them on every `system/init` frame and journals per-turn deltas.
Turns that die without a result frame — crash, closed pipe, sends that
never got a turn — journal as failed rows with zeros, covered by tests.

`agentd` writes rows (metadata only) to `journal.db` beside the task
store, prunes at 90 days on the existing maintenance interval, and
`thicket journal` queries it locally: recent turns, `--cost` per agent
over `--days`, `--failures`, `--trigger routine`.

Live on the rig: a DM turn journaled at $0.0491 / 1.6s and appeared in
both the listing and the per-agent cost rollup; an A2A message stamped
`thicket.trigger: routine` (the metadata key routines will use) journaled
as `routine` and came back alone under `--trigger routine`. The open
question resolved toward no second store: the CLI reads the account-local
journal file, and a fleet is queried per account.

## Live verification

See [LIVE-TESTING.md](../LIVE-TESTING.md) for the rig and the `slack-test` MCP
tools. Run a turn through Slack, then query the journal
from the CLI and confirm the turn is there with a cost attached.

## Out of scope

A metrics stack. The vision rules out anything that only pays off at fleet
sizes this will never reach — this is a local table and a query, not a
pipeline.
