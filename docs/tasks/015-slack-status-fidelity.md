---
id: "015"
title: Slack status fidelity and agent activity streaming
status: in-progress
component: apps/bridge
language: typescript
depends_on: ["009"]
blocks: []
parallel_safe: true
---

# Slack status fidelity and agent activity streaming

## Context

Filed from the first live DM round trips
(https://ivyevans.slack.com/archives/D0BT2RF1G9F/p1787802189980879 — Slack →
bridge → A2A → agentd → real Claude session). The answers are good; the
thread feels dead while they are produced. A turn that spends thirty seconds
reading files and running commands shows a spinner and nothing else, then a
wall of text.

Two separable things are wrong.

**Status.** The bridge calls `agents.sessions.setStatus` and never
`assistant.threads.setStatus`, and it was not established which surface each
one drives. Slack's reference settles it:

- `agents.sessions.setStatus` is the session *lifecycle* surface —
  `active | processing | suspended | closed`, no free text. `processing`
  raises the loading indicator and the stop button. It also accepts a `title`
  (≤200 chars) which names the session, but only on creation.
- `assistant.threads.setStatus` is the older free-text variant that cycles
  `loading_messages`; Slack documents it as running through a compatibility
  bridge and destined for deprecation.

So the bridge is on the right method and there is nothing to switch. What is
missing is that a turn's Slack side effects produce no log lines at all —
success is silent — and that sessions are never titled.

**Activity.** Nothing between "processing" and the final text tells the user
what the agent is doing. Slack's agent surface has exactly the primitive for
it: `chat.appendStream` takes a `chunks` array whose `task_update` entries
render as task cards (`in_progress | complete | error`, with a title and
details), and `chat.startStream` takes `task_display_mode`. The Claude Agent
SDK frame stream already carries the raw material — `tool_use` blocks on
assistant frames and the `tool_result` blocks that answer them.

## Scope

**Status fidelity.**

- Keep `agents.sessions.setStatus`; record the finding above so the question
  is not reopened.
- Log every Slack API side effect (method, channel, thread/stream ts, status)
  so a live turn is reconstructible from the bridge log.
- Title the session from the first user message of a thread, once, at
  creation.

**Activity streaming.**

- Executor: translate the frame stream's tool activity into A2A. A tool_use
  block opens an activity; its tool_result closes it as complete or error.
  Titles are rendered agent-side, because tool vocabulary is Claude Code's,
  not Slack's — the bridge stays Slack-generic.
- Carry activity as its own artifact stream (`agent-activity`, data parts)
  rather than overloading `TaskStatusUpdateEvent`, whose state the bridge maps
  onto Slack's session lifecycle.
- Bridge: render each activity as a `task_update` chunk on the thread's
  stream, starting the stream on first activity so the first card appears
  while the agent is still working.
- Activity must never be able to fail a turn: a rejected chunk downgrades to a
  logged warning and the stream carries on as plain text.
- Close the stream on any terminal state, not only on a text `lastChunk` — a
  turn whose last act is a tool call would otherwise leave it open forever.

## Acceptance criteria

- [ ] The bridge logs each Slack call it makes during a turn.
- [ ] A thread's session carries a title taken from its first message.
- [ ] A turn that uses tools shows task cards in Slack as the tools run,
      before the reply text arrives.
- [ ] A failing task-card write degrades to a warning; the reply still lands.
- [ ] A turn that ends without a final text chunk still closes its stream.

## Out of scope

Reactions (task 016). Grouped `plan` display mode: a turn's tool calls are not
known in advance, so there is no plan to render up front. Driving it from
`TodoWrite` is the obvious follow-on and belongs to its own task.
