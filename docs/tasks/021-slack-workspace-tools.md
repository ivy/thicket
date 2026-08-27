---
id: "021"
title: Slack workspace knowledge — search, history, and directory tools
status: todo
component: apps/bridge
language: typescript
depends_on: ["020"]
blocks: []
parallel_safe: true
---

# Slack workspace knowledge

## Context

An agent that can post but cannot read is writing into the dark. The
concrete case is a routine (task 022): *"post a summary in #claude-code only
when there are new release notes"* is unanswerable without knowing what was
already posted there.

More broadly, the workspace is where the operator's context lives — decisions
in threads, canvases, who is who. A memory store bolted onto thicket would
duplicate that badly; reading Slack directly does not. This is the honest
version of the RAG idea: not a new index to maintain, but access to the index
Slack already keeps.

This also gives `context: replay` its implementation. That roster field —
*native* means the harness keeps its own conversation state by `contextId`,
*replay* means it is stateless and needs the thread re-sent each turn — parses
and validates today and nothing reads it. Replay needs `conversations.replies`,
which is the same route these tools need.

## Scope

- Read routes on the bridge API, peer-tag authorized like the rest:
  channel history (`conversations.replies`, `conversations.history`), search,
  user and channel directory, canvases.
- Search runs on **`search:read.public`**, a legal bot scope. Plain
  `search:read` is user-token only — Slack rejects it in a bot manifest with
  `illegal_bot_scopes` — and a user token acts as the operator everywhere
  they can reach, which is a wider credential than anything in thicket and
  would land on the bridge every agent can now dial. Decided against; public
  channels are enough, and history covers any channel the app is in.
- Scope every read to what the agent's app can already see. An agent must not
  be able to read a private channel it was never invited to, and the bridge
  enforces that rather than trusting the tool argument.
- Implement `context: replay` on top of the history route, so the field stops
  being decorative and the "any harness" principle has a working example.

## Open questions

- Volume: a channel's full history can be very large. Reads need paging and a
  budget, or a routine will spend its whole turn scrolling.

## Acceptance criteria

- [ ] An agent can answer "what was already posted in this channel?" without
      the operator pasting it.
- [ ] A read the agent's app is not entitled to is refused by the bridge.
- [ ] `context: replay` drives a real turn for a harness that keeps no state.

## Live verification

See [LIVE-TESTING.md](LIVE-TESTING.md) for the rig and the `slack-test` MCP
tools. Post a known message with `slack_post`,
then ask the agent what was said in that channel. `context: replay` is
checkable by pointing a replay-configured agent at a thread with history.

## Out of scope

Building an index of our own. Any credential wider than the app already holds,
unless separately decided.
