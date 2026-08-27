---
id: "022"
title: Routines — agent-scheduled recurring prompts
status: icebox
component: apps/agentd
language: typescript
depends_on: ["020", "021", "026"]
blocks: []
parallel_safe: false
---

# Routines

## Context

The vision opens with standing work — patching, health monitoring, dependency
maintenance, an inbox — and every agent in thicket today is purely reactive.
It exists only in the seconds after a human types. Routines are what close
that gap: the agent gets on with it and speaks up when there is something to
say.

The worked example, which the design should be checked against:

> Check the Claude Code changelog at https://… every morning. Post a summary
> in #claude-code only when there are new release notes.

Every hard part of routines is in that sentence. It needs to remember what it
already reported (task 021), post somewhere it was not spoken to (task 020),
say nothing at all on most days, and be debuggable when it silently stops
working — which scheduled jobs reliably do.

`packages/executor/src/translator.ts` currently drops these on the floor:
`return; // unsolicited turn (scheduled/meta); nothing to translate`. A turn
with no A2A requester has nowhere to send its events, which is the real
problem to solve, not the scheduling.

## Scope

**The tools.** Full CRUD, so the agent manages its own routines conversationally:
create, list, update, delete. Cron syntax for the schedule. Nothing about a
routine should require editing a config file by hand.

**Silence is the default outcome.** A routine that finds nothing must produce
no Slack traffic at all — not an "all clear", not an empty thread. Most
mornings there is no new changelog, and a routine that speaks daily gets muted
within a week.

**Structured output, not prose.** A routine that decides to post must say so
through a tool call with a validated shape. The failure mode to design against
is the model replying in text and the reply going nowhere. On a malformed
call, an inaccessible channel, or a bad id, re-prompt with the error rather
than dropping the run.

**Accounting.** Scheduled work is flaky and fails quietly. Each run records
what fired, what it decided, what it posted, what it cost, and why it failed
(task 025 is the general form of this). Without it, a routine that has been
broken for a week is indistinguishable from a routine with nothing to report —
which is precisely the ambiguity the silence rule creates.

**Where the schedule lives.** Two candidates, and the choice matters:
- *Bridge-side*: the bridge fires an ordinary A2A message on a schedule.
  Everything downstream already works — status, cards, streaming — because it
  is indistinguishable from a human typing. Cheap, but the agent cannot
  schedule its own follow-ups.
- *Agent-side*: the Agent SDK already has cron (`SessionCronSummary`:
  expression, prompt, recurring or one-shot). Lets an agent say "remind me in
  an hour", but an agent-originated turn has no A2A requester and must push
  its output to the bridge instead.

The agent-side version is what the operator asked for and is the better end
state; bridge-side is the cheaper first step and does not have to be thrown
away.

## Open questions

- **Runaway cost.** An autonomous agent in a loop spends money unattended. A
  per-agent daily budget, or a cap on consecutive failing runs, probably
  belongs here rather than in its own task.
- **Missed fires.** A machine asleep at 09:00 — does the routine run late, or
  skip? Skipping is usually right for "every morning" and wrong for "every
  hour", so it may need to be per-routine.
- **Timezone.** Cron with no zone is a bug waiting to be filed.

## Acceptance criteria

- [ ] An agent can create, list, edit, and delete its own routines by being
      asked to, in conversation.
- [ ] A routine that finds nothing produces no Slack traffic.
- [ ] A routine that posts does so through a validated structured call; a
      malformed one is re-prompted, not dropped.
- [ ] Every run leaves a record explaining what happened, including the ones
      that decided to stay quiet.
- [ ] Routines survive an agentd restart.

## Out of scope

Cross-agent scheduling ("have forge do this weekly") — that is delegation,
task 023.
