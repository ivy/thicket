---
id: "025"
title: Turn journal — what happened, what it cost
status: icebox
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
- Durable and local, alongside the task store — same lifecycle, same account,
  no service to run.
- Queryable from the CLI: cost by agent over a window, recent failures,
  a routine's run history.
- Retention. This grows forever otherwise; the pruning that already exists for
  terminal tasks is the model.

## Open questions

- **Prompt and reply text: in or out?** Including them makes debugging vastly
  easier and turns the journal into a transcript of everything every agent has
  ever been told, on disk, in plaintext. Metadata-only is the safer default,
  with the full transcript behind an explicit per-agent opt-in.
- Whether the bridge needs its own view, or the CLI reading each agent's
  journal over A2A is enough. The latter avoids a second store.

## Acceptance criteria

- [ ] Every turn leaves a record, including ones that produced no output.
- [ ] Cost is answerable per agent and per time window from the CLI.
- [ ] A routine's history is inspectable without reading raw logs.
- [ ] The journal is bounded without operator intervention.

## Out of scope

A metrics stack. The vision rules out anything that only pays off at fleet
sizes this will never reach — this is a local table and a query, not a
pipeline.
