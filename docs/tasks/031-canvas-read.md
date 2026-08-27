---
id: "031"
title: Canvas read — the workspace's long-form memory, readable by agents
status: blocked
component: apps/bridge
language: typescript
depends_on: ["021"]
blocks: []
parallel_safe: true
---

# Canvas read

## Context

Task 021 gave agents messages, search, and the directory; canvases were in
its scope line but carry their own API surface (`canvases:read`, and
content retrieval that is not a one-call read — a canvas is a file whose
body needs the download path or section lookup). Split out so 021 could
land on its verified core rather than an unverified guess about the canvas
API.

The manifest already requests `canvases:read`.

## Scope

- Establish from Slack's docs how canvas content is actually read on a bot
  token (files.info + url_private download, `canvases.sections.lookup`, or
  both), and record the answer in 000-overview's external references.
- A bridge read route exposing a canvas's content as text/markdown, scoped
  like every other read: only canvases the agent's app can see.
- A `read_canvas` toolbelt tool on top of it.

## Acceptance criteria

- [ ] An agent can read the content of a canvas shared in a channel it is
      in, live.
- [ ] A canvas outside the app's reach is refused by the bridge.

## Out of scope

Writing or editing canvases.

## Blocked (2026-08-27)

The live verification — and the scope's first step, establishing the real
read format — both need an actual canvas to probe, and no path here can
produce one:

- The dev workspace is on Slack's free plan: `canvases.create` (tried via
  the operator's own Slack MCP) returns `not_supported_free_team`, matching
  the documented "free teams cannot create standalone canvases".
- Neither token can create one either: the bot token holds `canvases:read`
  but not `canvases:write`; the test-harness user token holds neither.
- `files.list?types=canvas` on the bot token returns an empty list — the
  workspace has never had a canvas.
- A free-plan *channel* canvas can be created, but only by a human in the
  Slack UI — squarely in LIVE-TESTING.md's "what still needs a human".

Building the route on a guessed response format is exactly what this task
was split out of 021 to avoid, so nothing lands until a canvas exists.

**To unblock, one of:**
1. Operator creates the channel canvas for `#thicket-test` by hand (channel
   → Canvas tab), which a free plan allows. Cheapest.
2. Workspace moves off the free plan, letting `canvases.create` run.
3. `canvases:write` is added to the manifest and the app reinstalled, after
   which the harness could create canvases where the plan allows it.

Already established for whoever picks this up: `canvases:read` is already
in the manifest; a canvas is a file (`files.list?types=canvas` sees them);
the file object's `url_private` carries the contents and Slack's own MCP
server "exports canvases as markdown", so the expected shape is a
bot-token GET of `url_private` — verify what it actually returns
(markdown vs HTML) before building the route.
