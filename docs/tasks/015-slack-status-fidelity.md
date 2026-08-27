---
id: "015"
title: Slack status fidelity and agent reactions
status: icebox
component: apps/bridge
language: typescript
depends_on: ["009", "013"]
blocks: []
parallel_safe: true
---

# Slack status fidelity and agent reactions

## Context

Filed from the first live DM round trip
(https://ivyevans.slack.com/archives/D0BT2RF1G9F/p1787802189980879 — Slack →
bridge → A2A → agentd → real Claude session, task `571e2363`, completed
2026-08-27T03:43Z).

What is known from that run:

- The bridge called **`agents.sessions.setStatus`** with `processing` and then
  `active`, and both calls returned `ok` (a failure would have thrown inside
  `runTurn` and failed the turn; the turn completed).
- **`assistant.threads.setStatus` was never called** — task 009 treated the
  `assistant.threads.*` family as deprecated and used only `agents.sessions.*`.

What is not known, and the docs suggest the two methods do *different things*
rather than being old/new names for the same thing:

- https://docs.slack.dev/reference/methods/agents.sessions.setStatus — appears
  to drive the **thread title**.
- https://docs.slack.dev/reference/methods/assistant.threads.setStatus — drives
  the **rotating list of status indicators** ("is thinking…"-style strings).

If that split is real, the bridge's status mapping (task 009's table) may be
writing to the wrong surface, or should write to both: the rotating indicator
for turn progress, `agents.sessions.rename`/title for session naming.

## Scope

**Status fidelity.**

- Determine empirically what each method changes in the client (title vs
  rotating indicator vs the container's busy state), and which one the
  `processing`-timeout semantics belong to.
- Rework `WebSlackApi`/the engine's status mapping to drive the correct
  surface(s); add per-call logging so a live turn's Slack side effects are
  observable afterwards (this run produced zero log lines — success is
  currently silent).
- Session titles: consider `agents.sessions.rename` from the first user
  message or the task summary.

**Agent reactions (idea).**

Give agents an expressive channel presence beyond replies: an MCP server
exposed *to the agent's Claude session* with tools like
`react(message_ts, emoji)` (backed by `reactions.add`), so an agent can
acknowledge a message with 👀 while working or ✅ when done instead of — or in
addition to — posting. Needs thought on which surface owns the bot token
(the bridge holds Slack credentials; agents must not), so this likely means a
small bridge-side API the agent-side MCP tool calls over A2A or a side
channel.

## Acceptance criteria

- [ ] A documented answer (with screenshots or client observations) for what
      each setStatus method visibly does in current Slack clients.
- [ ] The bridge drives the rotating status indicator during `working` and
      clears it on terminal states; titles are set deliberately, not as a side
      effect.
- [ ] Slack API side effects of a turn are visible in bridge logs.
- [ ] A decision (build / don't build) on the reactions MCP tool, with the
      credential-boundary question answered.

## Out of scope

Changing the A2A status model (task 005/008). Anything requiring agents to
hold Slack tokens.
