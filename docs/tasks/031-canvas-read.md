---
id: "031"
title: Canvas read — the workspace's long-form memory, readable by agents
status: todo
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
