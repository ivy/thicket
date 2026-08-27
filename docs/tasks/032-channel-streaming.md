---
id: "032"
title: A mention in a channel fails at chat.startStream
status: todo
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

- [ ] A mention in `#thicket-test` streams a reply in-thread, live.
- [ ] A DM turn still streams as before, live.
- [ ] The failure mode for a stream Slack still refuses is a posted
      message, not a dead turn.

## Out of scope

Channel-join automation; the app still has to be invited.
