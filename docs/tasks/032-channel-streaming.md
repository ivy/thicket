---
id: "032"
title: A mention in a channel fails at chat.startStream
status: done
component: apps/bridge
language: typescript
depends_on: ["015"]
blocks: []
parallel_safe: true
---

# A mention in a channel fails at chat.startStream

## Context

Observed live during 021 verification: mentioning hearth in a channel
thread (`#thicket-test`) failed the whole turn —

```
turn failed ... err: An API error occurred: missing_recipient_team_id
```

right after `chat.startStream` with only `channel` + `thread_ts`. Every
prior live turn ran in a DM, where the recipient is implied; in a channel,
Slack's streaming API needs to be told who the stream's requester is
(`recipient_team_id` and `recipient_user_id`), and the bridge never passes
them. So today an agent can be spoken to in a DM but not mentioned in a
channel, which undercuts the channel-facing capabilities (posting, reading,
and eventually routines) that landed with 020/021.

## Scope

- Verify against Slack's chat.startStream reference which recipient fields
  are required for channel streams, and record the fact in 000-overview.
- Carry the triggering message's author through the engine to the stream
  call (the InboundEvent already has `authorId`; team id may need
  `auth.test` or the event's context).
- A DM turn must be unaffected.

## Acceptance criteria

- [x] A mention in `#thicket-test` streams a reply in-thread, live.
- [x] A DM turn still streams as before, live.
- [x] The failure mode for a stream Slack still refuses is a posted
      message, not a dead turn.

## What verification established (2026-08-27)

Slack's reference confirms both `recipient_user_id` and
`recipient_team_id` are "required when streaming to channels"; the team
id comes from `auth.test` (asked once, cached). The triggering message's
author now rides the task row (like `message_ts` before it), so the
stream is addressed to whoever asked, and the queue preserves it across
an unreachable-agent replay. DM streams carry neither field — that path
is byte-identical to before, verified live alongside the fix.

Live: the same mention shape that died at `missing_recipient_team_id`
now streams in-thread (`chat.startStream` logged with
`recipient_user_id: U02…, recipient_team_id: T02…`), and a DM turn
still streams with neither field.

The refusal path is covered by test: a stream Slack refuses buffers the
answer text and delivers it as one plain message when the turn settles —
streaming is presentation, never worth losing the answer.

## Out of scope

Channel-join automation; the app still has to be invited.
