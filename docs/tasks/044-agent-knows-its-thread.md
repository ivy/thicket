---
id: "044"
title: The agent knows which Slack thread it is in
status: todo
component: packages/executor
language: typescript
depends_on: ["005", "009", "020"]
blocks: ["043"]
parallel_safe: true
---

# The agent knows which Slack thread it is in

## Context

Observed during 035's live check (2026-08-28): asked to "use your thicket
`read_thread` tool to read this very thread back", the agent found the tool,
then answered that it had no channel id or thread ts to pass it. It was
right. The bridge sends the A2A message with the Slack text and the
attachment refs, but the channel and thread coordinates never leave the
bridge — the only Slack-shaped metadata on a message is `thicket.shouldQuery`
and a file size. So every toolbelt call that takes `channel` and
`thread_ts` (`read_thread`, `post_message`, `upload_file`, `react`) can
only reach threads the operator names by id, never the one the
conversation is happening in.

043 assumes "Slack thread coordinates already travel in message metadata"
and adds a workspace name alongside them. This task is what makes that
premise true.

## Scope

- Bridge: put the inbound message's channel id and thread root ts on the
  A2A message metadata, under `thicket.`-prefixed keys declared next to
  the existing ones in `packages/executor/src/types.ts`.
- Executor: when those keys are present, the turn preamble tells the model
  where it is — one short line naming the channel id and thread ts, in the
  same place the attachment preamble already goes. A message without them
  (the MCP path from local Claude Code, scheduled prompts) gets no line.
- Toolbelt descriptions for the thread-taking tools say that "this thread"
  is the one named in the preamble, so the model reaches for it instead of
  apologising.

## Acceptance criteria

- [ ] In a DM, "read this thread back with your thicket tool" succeeds and
      the reply quotes the thread — observed live.
- [ ] The same in a channel thread the agent was mentioned in.
- [ ] A turn started from the local MCP server carries no coordinates and
      the preamble says nothing about a thread.
- [ ] The bridge log still records no message content — the new metadata is
      ids only.

## Out of scope

Workspace binding (043). Any change to `contextId` derivation. Teaching the
model about channels it is not in.
