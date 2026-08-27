---
id: "021"
title: Slack workspace knowledge — search, history, and directory tools
status: icebox
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
- Slack's realtime search is hybrid retrieval and is the interesting one:
  the workspace's own index, no embedding pipeline to own.
- Scope every read to what the agent's app can already see. An agent must not
  be able to read a private channel it was never invited to, and the bridge
  enforces that rather than trusting the tool argument.
- Implement `context: replay` on top of the history route, so the field stops
  being decorative and the "any harness" principle has a working example.

## Open questions

- Which search API is actually available on this workspace's plan, and
  whether it needs a user token rather than a bot token — a user token would
  be a materially wider credential and deserves its own decision.
- Volume: a channel's full history can be very large. Reads need paging and a
  budget, or a routine will spend its whole turn scrolling.

## Acceptance criteria

- [ ] An agent can answer "what was already posted in this channel?" without
      the operator pasting it.
- [ ] A read the agent's app is not entitled to is refused by the bridge.
- [ ] `context: replay` drives a real turn for a harness that keeps no state.

## Out of scope

Building an index of our own. Any credential wider than the app already holds,
unless separately decided.
