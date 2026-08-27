# Live testing

Referenced by task files rather than repeated in them.

Unit tests prove a seam behaves. They have never once caught the things that
actually broke here — `getSessionInfo` resolving `undefined`, the macOS
keychain wanting `USER`, a stream refusing `markdown_text` after a chunk, a
manifest field the docs describe wrongly. Every one of those needed the real
thing. So a task is not finished when its tests pass; it is finished when it
has been watched working.

## The rig

Five processes, all local, started from `~/thicket-test/`:

| | |
|---|---|
| `agentd` | the agent, on a unix socket |
| `bridge` | Slack Socket Mode ↔ A2A, plus the file surface on its own socket |
| `peer-tag-proxy` ×2 | `deploy/dev/peer-tag-proxy.mjs`, standing in for netd inbound — one in front of agentd carrying `tag:thicket-bridge`, one in front of the bridge carrying `tag:thicket-hearth` |
| `egress-proxy` | `deploy/dev/egress-proxy.mjs`, standing in for netd outbound |

Both stand-ins assert an identity that netd would verify, which is exactly
why they are development-only. Restart a process after rebuilding: the
running one holds the old code.

## Driving Slack

The `slack-test` MCP server (`thicket slack-test-mcp`, configured in
`.mcp.json`) acts as the operator, because nothing else can: the bridge
ignores `bot_id` messages so agents cannot answer themselves, which also
means no bot token can start a turn.

- `slack_dm_agent` — say something to an agent; returns the channel and the
  thread root.
- `slack_await_reply` — block until the agent answers, then report the reply
  with its Block Kit structure. This is the assertion most checks reduce to.
- `slack_thread`, `slack_history` — what is in a thread or channel, with
  block types and attached files, for asserting on task cards and streams.
- `slack_upload` — send a file, to exercise attachment handling end to end.
- `slack_reactions` — what an agent reacted with.
- `slack_post` — post into a channel, for routines and channel-scoped work.

Confine live traffic to `#thicket-test` where a channel is needed. It is a
development workspace, so noise is cheap, but a wall of test messages in a
DM makes the next real conversation harder to read.

## Reading what happened

The bridge logs one line per inbound Slack event (shape only, never content)
and one per Slack API call, nested under `slack` so an argument named `ts`
cannot shadow the record's own timestamp. When something produces no
response, that log is what separates "Slack never delivered it" from "we
declined to act on it" — a distinction that cost two debugging rounds before
those lines existed.

```
tail -f ~/thicket-test/bridge.log
tail -f ~/thicket-test/agentd.log
```

The task store holds what the agent actually answered:
`~/thicket-test/state/thicket/agentd/tasks.db`, table `tasks`, column
`task_json`.

## What still needs a human

Do not mark these observed. Leave the box unchecked, say so in the landing
commit, and they get walked through together.

- **Clicking anything.** A Block Kit button arrives as a `block_actions`
  payload over Socket Mode; MCP servers post and read, they do not synthesise
  interactions. Approvals and the stop button are in this category.
- **Whether it looks right.** `agents.sessions.setStatus` returned `ok` on
  every call while the operator saw no status indicator at all. The API
  saying yes is not the client showing it.
- **A second host.** Anything needing real systemd, a real tailnet, or a
  second agent account.

## Rules

- Never run `provision`. It mutates a live Slack workspace against a Tier 1
  rate limit, and manifest changes need a browser reinstall no automation can
  perform. Change the renderer, land it, and say in the commit that a
  provision is owed.
- Never push, never open a PR, never touch a remote.
- If a live check fails in a way the code cannot explain, prefer adding the
  missing log line over guessing. Every mystery in this project so far ended
  at a path that recorded nothing.
