---
id: "034"
title: Split long replies at boundaries the reader can live with
status: in-progress
component: apps/bridge
language: typescript
depends_on: ["032"]
blocks: []
parallel_safe: true
---

# Split long replies at boundaries the reader can live with

## Context

Observed live (operator report, 2026-08-27 18:19): a long streamed answer
broke **mid-word** across two Slack messages — `…That's how it can in` /
`spect the HTTP path…` — and its continuation split again at an arbitrary
point. The bridge log tells the whole story:

1. `chat.appendStream` hit `msg_too_long` once the streamed message
   filled up (~3,000 chars of text plus 24 task cards);
2. the 032 degradation buffered every later chunk — starting mid-word,
   because SDK text deltas break anywhere — and posted the remainder as
   one 4,692-char message at terminal;
3. Slack then split that post itself at ~4,000 chars, also arbitrarily.

The facts, from Slack's docs (recorded in 000-overview):

- `chat.postMessage` truncates past 40,000 chars; official guidance is to
  keep messages ≤ 4,000, and Slack reserves the right to split longer
  ones into multiple messages at points of its choosing.
- A streamed message has its own effective cap (observed `msg_too_long`
  at roughly 3k chars + cards); `markdown_text` per append is capped at
  12,000.

## Scope

- **Stream rollover.** The engine budgets appended text per stream
  (~2,800 chars, margin under the observed cap). When the next chunk
  would blow the budget, split *inside the chunk* at the last
  newline-or-space that fits, close the stream cleanly, start a fresh
  stream message for the same task, and continue there — so a long
  answer becomes several well-formed messages instead of one mid-word
  amputation plus an unformatted tail.
- **Post splitting.** `WebSlackApi.postMessage` splits any text over
  ~3,500 chars at paragraph → newline → space boundaries into sequential
  messages, so Slack never applies its own arbitrary split. Every caller
  (streamless buffer, blocking finish, error notices) inherits it.
- The `msg_too_long` degradation from 032 stays as the backstop.

## Acceptance criteria

- [ ] A streamed answer longer than one Slack message's worth arrives as
      multiple messages, each ending at a whitespace boundary, all
      streamed (no unformatted plain-text tail).
- [ ] A single `postMessage` longer than the split threshold arrives as
      sequential messages split at paragraph or line boundaries.
- [ ] Normal-length turns behave exactly as before.

## Live verification

Ask the agent for a deliberately long answer (several thousand words) in
a DM and inspect the resulting messages' boundaries.

## Out of scope

Icons on task cards (035). Raising Slack's limits.
