---
id: "016"
title: Agent-initiated Slack reactions
status: in-progress
component: apps/bridge
language: typescript
depends_on: ["020", "026"]
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

The credential boundary was the open question: the bridge holds the Slack bot
token, agents run as unprivileged unix users on other machines and must never
see it, so the agent side can only ever name a reaction and something
bridge-side has to redeem it.

Task 017 answered the mechanism question by building the surface: the bridge
serves an authenticated HTTP API over a unix socket behind its own netd, with
authorization a peer-tag read plus a lookup in bridge state. Reactions become
a second route on it, and the Claude Agent SDK's in-process MCP servers
(`createSdkMcpServer`) mean exposing it to the model costs a JS object rather
than a subprocess.

That splits the remaining question in two: what the bridge's API allows, and
which parts of it the *model* gets to invoke. Attachments never needed the
model in the loop; reactions do.

## Scope

- A write route on the bridge's file surface: `react(message_ts, emoji)`
  backed by `reactions.add`.
- The agent may name only messages in the thread it is currently answering —
  the bridge resolves `message_ts` against its own record of the thread,
  never trusting an arbitrary channel/ts pair. A write route widens the
  trust-graph edge 017 opened, so this constraint is the whole design.
- A `react` tool on the agent's toolbelt (task 020).
- The bridge puts 👀 on the message that opens a session, automatically — the
  acknowledgement that costs nothing and is always correct. Everything after
  that is the agent's judgement.
- Emoji use has to be *situational and varied* to be worth having. The same
  reaction every time reads as a status light, not a presence. That is
  instruction rather than tool design, and it is the first real use for a
  per-agent persona (task 026).
- Rate limiting: `reactions.add` is Tier 3; a chatty agent must not burn the
  workspace's budget.

## Acceptance criteria

- [ ] An agent can react to the message it is answering, and cannot react to
      anything else — including messages in another thread of its own.
- [ ] Reaction failures never fail the turn.
- [ ] The agent holds no Slack credential.

## Live verification

See [LIVE-TESTING.md](LIVE-TESTING.md) for the rig and the `slack-test` MCP
tools. `slack_dm_agent`, then `slack_reactions` on the
message you sent — 👀 should appear from the bridge without the agent doing
anything. Whether the agent's own later reactions are *well chosen* is a
judgement call; leave that box for the operator.

## Out of scope

Anything that puts a Slack token on an agent host.
