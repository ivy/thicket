# Live testing

Referenced by task files rather than repeated in them.

Unit tests prove a seam behaves. They have never once caught the things that
actually broke here — `getSessionInfo` resolving `undefined`, the macOS
keychain wanting `USER`, a stream refusing `markdown_text` after a chunk, a
manifest field the docs describe wrongly. Every one of those needed the real
thing. So a task is not finished when its tests pass; it is finished when it
has been watched working.

## The rig

```sh
mise exec -- pnpm compile     # the rig runs dist-bin/, not src/
./deploy/dev/rig.sh restart   # after every compile — a running process holds the old code
./deploy/dev/rig.sh status    # per-process, plus whether the agent card actually answers
```

Recompiling and restarting is not optional housekeeping. Skip either and
every live check measures the previous commit, which is worse than no check
at all because it looks like one. agentd and the bridge run as the same
standalone binaries an agent account installs; only the netd stand-ins are
still scripts, run under `bun`.

Five processes, all local, under `~/thicket-test/`:

| | |
|---|---|
| `agentd` | the agent, on a unix socket |
| `bridge` | Slack Socket Mode ↔ A2A, plus the file surface on its own socket |
| `peer-tag-proxy` ×2 | `deploy/dev/peer-tag-proxy.mjs`, standing in for netd inbound — one in front of agentd carrying `tag:thicket-bridge`, one in front of the bridge carrying `tag:thicket-hearth` |
| `egress-proxy` | `deploy/dev/egress-proxy.mjs`, standing in for netd outbound |

Both stand-ins assert an identity that netd would verify, which is exactly
why they are development-only.

Logs and pidfiles sit beside each other in `~/thicket-test/`, one pair per
process. `status` checks liveness rather than presence — it asks the agent
card, because a process can be up and not serving.

The CLI reaches the rig the way it would reach a real fleet — through the
egress stand-in, to the agent's address — given the rig's roster and two
overrides:

```sh
THICKET_AGENTS_FILE=~/thicket-test/config/thicket/agents.yaml \
THICKET_MCP_ENDPOINTS='{"hearth":"http://127.0.0.1:8791"}' \
THICKET_EGRESS_SOCKET=~/thicket-test/run/thicket/netd-egress.sock \
  ./dist-bin/bun-darwin-arm64/thicket fleet          # or: mcp
```

The endpoint is the peer-tag proxy in front of agentd, so the call arrives
carrying the bridge's tag, which is the only one agentd admits.

## Driving Slack

Two MCP servers, and the split matters.

**`slack`** — Slack's own, hosted at `https://mcp.slack.com/mcp`. Reach for it
first: searching messages, files, users and channels; posting; reading
channels and threads; reactions; canvases; user info. It authenticates as the
operator over OAuth.

Install it with `/plugin install slack`. Slack's auth server uses a
pre-registered OAuth client rather than RFC 7591 dynamic registration, so a
plain `.mcp.json` entry fails with "Incompatible auth server: does not
support dynamic client registration" — there is nowhere in one to put a
client id. The plugin carries Slack's.

If the plugin is ever unavailable, the same thing can be done by hand, since
Slack publishes both values (client id `1601185624273.8899143856786`,
callback port `3118`):

```sh
claude mcp add --transport http -s project \
  --client-id 1601185624273.8899143856786 --callback-port 3118 \
  slack https://mcp.slack.com/mcp
```

Either route still ends at a browser consent flow.

**`slack-test`** — three tools this repo adds, and only because Slack's server
lacks them:

- `slack_dm_agent` — say something to an agent. Resolves the agent name to
  its bot user's DM, which is thicket-specific knowledge. Returns the channel
  and the thread root.
- `slack_await_reply` — block until the agent answers, then report the reply
  with its Block Kit structure. A turn is asynchronous; without this every
  test writes its own poll loop against a rate-limited read. This is the
  assertion most checks reduce to.
- `slack_upload` — send a file. Absent upstream, and attachment ingest has no
  live regression test without it.

Anything else — reading the thread back, checking reactions, searching —
comes from `slack`. Do not add tools here that duplicate it.

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
