---
id: "035"
title: Task cards carry an icon that says what kind of step this is
status: todo
component: packages/executor
language: typescript
depends_on: ["015"]
blocks: []
parallel_safe: true
---

# Task cards carry an icon that says what kind of step this is

## Context

Operator report (2026-08-27): the task-card timeline renders every step
with the same look; the tool calls should carry distinguishing icons.

Established from the docs first: **emoji are not supported** as task-card
icons. The `task_card` block's `icon` field takes a Slack icon object —
`{"type": "icon", "name": <one of a fixed set>}` — whose full name set is
(slack-icon composition object reference):

archive, book, bookmark, bot, bug, calendar, call, caret-left,
caret-right, check, clipboard, code, comment, compass, copy, cube,
download, edit, email, eye-closed, eye-open, file, flag, folder, gear,
globe, heart, help, image, info, key, lightbulb, link, map, mobile,
new-window, pin, plus, refine, refresh, rocket, save, screen, share,
sparkle, star, star-filled, tag, thumbs-down, thumbs-up, trash, upload,
user, warning.

## Scope

- `describeToolUse` (packages/executor/src/activity.ts) already maps tool
  names to human titles; it additionally picks an icon name from the set
  above. A sensible starter mapping: Bash → `code`, Read → `file`,
  Edit/Write → `edit`, Grep/Glob → `refine`, WebFetch/WebSearch →
  `globe`, TodoWrite → `clipboard`, Task/agents → `bot`,
  thicket post/upload tools → `comment`/`upload`, thicket read tools →
  `book`, routines CRUD → `calendar`, unknown → `gear`.
- `AgentActivity` carries the optional icon through the activity artifact;
  the bridge's `appendActivity` puts it on the `task_update` chunk as
  `{"type": "icon", "name": …}`.
- A card with no icon renders exactly as today.

## Acceptance criteria

- [ ] Different tool kinds render with different icons in a live
      timeline (operator eyeballs a turn that uses Bash, a read, and a
      thicket tool).
- [ ] An unknown tool still renders, with the fallback icon.

## Out of scope

Message-length splitting (034). Custom images as icons.
