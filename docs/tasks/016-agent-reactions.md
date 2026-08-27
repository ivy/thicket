---
id: "016"
title: Agent-initiated Slack reactions
status: icebox
component: apps/bridge
language: typescript
depends_on: ["009"]
blocks: []
parallel_safe: true
---

# Agent-initiated Slack reactions

## Context

Split out of task 015 so the status/activity work could land without it.

Agents currently have exactly one way to be present in a channel: posting a
reply. A reaction is a cheaper signal — 👀 on the message it picked up, ✅ when
it finished, 🤔 when it is stuck — and it lands on the *user's* message rather
than adding noise to the thread.

The credential boundary is the whole problem. The bridge holds the Slack bot
token; agents run as unprivileged unix users on other machines and must never
see it. So the agent side can only ever hold a capability that names a
reaction, and something bridge-side has to redeem it.

## Scope

- Decide the mechanism. Two candidates:
  - An MCP server exposed to the agent's Claude session (`react(message_ts,
    emoji)`) that calls a small bridge-side API over the same transport the
    bridge already dials, authenticated by the peer tag netd already
    verifies. Agents keep no Slack credential.
  - An A2A-native path: the agent emits a structured artifact the bridge
    interprets (the shape task 015 introduced for activity), so no new
    inbound surface exists at all. Cheaper, but one-way and only during a
    turn.
- Whichever wins, the agent must be able to name only messages in the thread
  it is currently answering — the bridge resolves `message_ts` against its own
  record of the thread, never trusting an arbitrary channel/ts pair.
- Rate limiting: `reactions.add` is Tier 3; a chatty agent must not burn the
  workspace's budget.

## Acceptance criteria

- [ ] A decision (build / don't build) with the credential-boundary question
      answered in writing.
- [ ] If built: an agent can react to the message it is answering, and cannot
      react to anything else.
- [ ] If built: reaction failures never fail the turn.

## Out of scope

Anything that puts a Slack token on an agent host.
