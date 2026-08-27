---
id: "025"
title: Turn journal — what happened, what it cost
status: todo
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

- [ ] Every turn leaves a record, including ones that produced no output.
- [ ] Cost is answerable per agent and per time window from the CLI.
- [ ] A routine's history is inspectable without reading raw logs.
- [ ] The journal is bounded without operator intervention.

## Live verification

See [LIVE-TESTING.md](LIVE-TESTING.md) for the rig and the `slack-test` MCP
tools. Run a turn through Slack, then query the journal
from the CLI and confirm the turn is there with a cost attached.

## Out of scope

A metrics stack. The vision rules out anything that only pays off at fleet
sizes this will never reach — this is a local table and a query, not a
pipeline.
