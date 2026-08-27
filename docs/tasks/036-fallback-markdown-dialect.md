---
id: "036"
title: Fallback posts speak markdown, like the stream they stand in for
status: todo
component: apps/bridge
language: typescript
depends_on: ["032"]
blocks: []
parallel_safe: true
---

# Fallback posts speak markdown, like the stream they stand in for

## Context

Operator report (2026-08-27): a message in the long-answer thread showed
literal `##` headings and `**bold**` markers. Diagnosis from the raw
message: it was the 032 streamless fallback, whose buffered **markdown**
was posted through `chat.postMessage`'s `text` field — which Slack parses
as **mrkdwn**, a different dialect (bold is `*single*`, no `#` headings,
no `-` lists). The streamed message right above it rendered the same
content correctly (`header` blocks and all), because `chat.appendStream`
chunks are real markdown. Not a wrong chunk type; a wrong dialect on the
fallback surface — and the length cap is only what routed text onto it.

The docs' answer: `chat.postMessage` accepts a `markdown_text` argument
("formatted in markdown", 12,000-char limit, mutually exclusive with
`text`/`blocks`) — the same field family the streaming methods use.

## Scope

- `WebSlackApi.postMessage` sends `markdown_text` instead of `text`, so
  every bridge-authored post — the streamless fallback, blocking
  finishes, error notices — renders in the dialect the model actually
  writes. Plain prose is unchanged by markdown parsing.
- Splitting (034) still applies first; each piece stays far under the
  12,000-char `markdown_text` cap.

## Open question (not this task)

The toolbelt's `/api/messages` route still posts agent-supplied text as
mrkdwn `text`. Models write markdown there too, but switching it changes
the tool's mention syntax contract (`<@U…>` vs `![](@U…)`) and deserves
its own verified decision.

## Acceptance criteria

- [ ] A fallback-path post containing `##` headings and `**bold**`
      renders them as formatting, not literal characters.
- [ ] The message-body privacy rule holds: logs still record lengths,
      never content.

## Out of scope

The toolbelt post_message dialect (see open question). Re-streaming.
