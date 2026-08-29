---
id: "038"
title: One-shot scheduled prompts — "check on this tomorrow at 9"
status: done
component: apps/agentd
language: typescript
depends_on: ["022"]
blocks: []
parallel_safe: true
---

# One-shot scheduled prompts

## Context

Routines (022) cover standing work; the missing shape is the one-off:
*"Hey hearth — check if XYZ is finished running tomorrow at 9am."* Said
in a thread, meaning: come back to **this conversation** at that time,
with **this conversation's context**, and report here.

Two deliberate differences from cron routines follow from that sentence:

- **Context.** "XYZ" is defined by the thread where the ask happened. A
  one-shot should run in the *origin thread's* contextId — the session
  that already knows what XYZ is — not in a routine-private context, and
  its output should land back in the origin channel/thread (recorded at
  creation; the fired prompt says where to post).
- **Missed fires catch up.** Cron skips minutes the machine slept
  through ("every morning" must not fire three times at noon), but a
  one-shot that was asleep at 9am should fire when the machine wakes:
  late beats never for "check on this". Fire when `now >= at` and not
  yet fired — exactly the per-policy split 022's open question predicted.

## Scope

- Extend the routine store with a schedule kind: `cron` (existing) or
  `at` (epoch ms, one-shot), plus origin `channel`/`thread_ts`/context
  for one-shots. One store, so `routine_list` and `routine_delete`
  cover one-shots for free; a fired one-shot is marked done (kept for
  the listing's history, pruned with the journal's retention).
- A `schedule_once` toolbelt tool: `at` (ISO local time — the model
  converts "tomorrow at 9" itself; reject past times with a usable
  error), `prompt`, and the origin coordinates the bridge already knows
  (threaded through message metadata like `thicket.trigger`, or
  captured bridge-side — decide at implementation, but the agent must
  not be able to claim an arbitrary origin).
- Runner: catch-up semantics for `at` entries; the fired turn runs in
  the origin context with the same framing as routines (reply text goes
  nowhere; speak through post_message to the recorded origin), journals
  as `trigger: schedule` so `thicket journal --trigger schedule` shows
  the history.
- Failure accounting: a one-shot gets one retry at most on a failed
  run, then reports its failure to the origin thread via the
  disablement-report pattern — a silent no-show is the worst outcome
  for "check on this tomorrow".

## Acceptance criteria

- [x] Asking in a thread schedules a one-shot; `routine_list` shows it
      with its fire time. Observed 2026-08-28 in the hearth DM: "post the
      word ping in this thread two minutes from now" became an `at` row
      (`d079a682`, at 21:18:09 local, origin channel/thread recorded) with
      no coordinates supplied by the model — the toolbelt asked the
      bridge, keyed by its session. `routine_list` renders `kind`, `at`,
      `fired`, and the origin (`toolbelt.test.ts`).
- [x] At fire time the turn runs in the origin thread's context and the
      answer arrives in that thread. "ping" arrived in the asking thread
      at 21:18:26; the journal row's `context_id` equals the bridge's
      context for that thread and `deriveSessionId(channel, thread)`,
      byte for byte.
- [x] A fire time that passes while agentd is down fires on the next
      start, once. Second round, fire time 21:21:00: rig stopped 21:19:36,
      started 21:21:41, `one-shot fired … lateMs: 61826` at 21:22:01,
      "heliotrope" in the thread at 21:22:10 — one fire line, one post.
- [x] A fired one-shot never fires again; deleting an unfired one
      cancels it. Both rows carry `fired_ms`; the log has exactly one
      `one-shot fired` per id across every tick since. Delete-cancels and
      disabled-waits are `routines.test.ts`; `routine_update` refuses to
      re-time a one-shot and `routine_delete` removes it
      (`toolbelt.test.ts`).
- [x] The run is journaled, including failures. `thicket journal
      --trigger schedule` lists both live runs (completed, post_message,
      cost). A failing run is retried once and then reported to the
      origin thread with the error, after which the row is spent
      (`routines.test.ts`); the failed turns journal through the same
      executor path every turn does.

## Live verification

Schedule "post the word ping in this thread in two minutes" in a DM,
watch it arrive; schedule another, stop the rig across the fire time,
restart, watch it arrive once. Verify the origin-context memory by
scheduling "report the secret word here in two minutes" after telling
the thread a secret word.

## Out of scope

Recurring schedules (022 owns cron). Cross-agent scheduling (023).
Natural-language time parsing bridge-side — the model does that.
