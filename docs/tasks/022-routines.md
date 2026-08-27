---
id: "022"
title: Routines — agent-scheduled recurring prompts
status: done
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

**The schedule lives agent-side.** Decided: the agent owns its routines and
manages them by being asked to, which a bridge-side scheduler cannot offer.
*Amended in implementation:* the SDK's session crons turned out to be the
wrong substrate — they exist only while a session subprocess is alive, so
TTL eviction and restarts would silently kill them, and their per-thread
scoping fragments CRUD across conversations. The schedule lives in
**agentd** instead (same account, same host — still agent-side), in a
durable store the scheduler re-arms at boot. The turn-with-no-requester
problem dissolved rather than needing solving: agentd fires a routine by
sending itself a normal A2A message (metadata `thicket.trigger: routine`),
so the translator, task store, and journal all apply unchanged, the reply
text streams back to agentd and is discarded, and anything worth saying
goes through the toolbelt.

**Fail closed.** Five consecutive failing runs disables a routine and reports
once. An autonomous agent looping unattended spends real money, and a routine
designed to be silent is the worst possible place for a silent failure.

## Open questions

- **Missed fires.** Resolved: skipped, never replayed — the scheduler only
  matches the current minute, so minutes that pass while the process is
  down or the machine asleep simply do not fire. "Every morning" stays
  once-a-morning; a per-routine catch-up policy can come later if an
  hourly routine ever wants it.
- **Timezone.** Resolved: host local time, stated in the tool description
  the model reads when creating a schedule.

## Acceptance criteria

- [x] An agent can create, list, edit, and delete its own routines by being
      asked to, in conversation.
- [x] A routine that finds nothing produces no Slack traffic.
- [x] A routine that posts does so through a validated structured call; a
      malformed one is re-prompted, not dropped.
- [x] Every run leaves a record explaining what happened, including the ones
      that decided to stay quiet.
- [x] Routines survive an agentd restart.

## What live verification established (2026-08-27)

The worked example ran for real, as `banana-watch` (`* * * * *`) watching
`#thicket-test`:

- Created, listed, edited (schedule + enabled flag, verified in the
  store), and deleted purely by asking hearth in a DM.
- Two quiet runs before the marker: the journal shows them
  (`trigger: routine`, tools `read_channel`, completed, with cost) and the
  channel shows nothing — the run record is exactly what makes verified
  silence different from a dead routine.
- `BANANA delivery has arrived` planted at 09:14:02; the routine posted
  the exact string ten seconds later, and the journal's posting run shows
  `read_channel, post_message`. The two runs after it stayed silent:
  session-per-routine memory answers "did I already report this?".
- A rig restart reloaded the store (`routine scheduler running,
  routines: 1`) and the next minute fired normally.
- `cron: "every day at noonish"` came back as the tool's structured
  validation error, quoted verbatim by the model, with nothing created;
  Slack-side failures re-prompt the same way (the 020/021 error paths).

Fail-closed (five failures → disabled + one agent-delivered report) is
covered by unit tests; staging five real consecutive failures live was
not worth the money it exists to save.

## Live verification

See [LIVE-TESTING.md](LIVE-TESTING.md) for the rig and the `slack-test` MCP
tools. The whole point is the changelog example. Create a
routine through conversation, force it to fire, and confirm: it posts when
there is something new, and posts *nothing at all* when there is not — verify
the silence with `slack_history`, since an absent message is the assertion.

## Out of scope

Cross-agent scheduling ("have forge do this weekly") — that is delegation,
task 023.
