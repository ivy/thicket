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

Six processes, all local, under `~/thicket-test/`:

| | |
|---|---|
| `agentd` | the agent, on a unix socket |
| `bridge` | Slack Socket Mode ↔ A2A, plus the file surface on its own socket |
| `phone` | Twilio ConversationRelay ↔ A2A, on `127.0.0.1:8793`, with `tailscale funnel` in front so Twilio can reach it |
| `peer-tag-proxy` ×2 | `deploy/dev/peer-tag-proxy.mjs`, standing in for netd inbound — one in front of agentd carrying `tag:thicket-bridge`, one in front of the bridge carrying `tag:thicket-hearth` |
| `egress-proxy` | `deploy/dev/egress-proxy.mjs`, standing in for netd outbound |

Both stand-ins assert an identity that netd would verify, which is exactly
why they are development-only. The phone bridge dials the agent through
the same stand-in the Slack bridge uses, so it arrives carrying the
bridge's tag; in deployment it has its own.

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
  ./dist-bin/macos-arm64/thicket fleet               # or: mcp
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

## Driving the phone

The phone bridge is the one component the public internet reaches, so a
live check needs three things the rig cannot make for you:

1. **`~/thicket-test/config/thicket/phone.json`, mode 0600** — the
   operator's numbers, the PIN, the Twilio credentials and number, the
   alerts channel, and `"listen": "127.0.0.1:8793"`. Its schema is
   `apps/phone/src/config.ts`; `rig.sh start` skips the phone bridge when
   the file is absent and says so. The values are the ones parked in
   `.env`; the bridge never reads `.env`.
2. **`phone.enabled: true` and a `spokenName`** on the agent in the rig's
   `agents.yaml`, or Aiva has nobody to offer.
3. **The Twilio number pointed at the rig, by hand**, until provisioning
   exists: in the Console (or over REST) the number's voice URL is
   `$THICKET_PUBLIC_BASE_URL/voice` (POST) and its status callback
   `$THICKET_PUBLIC_BASE_URL/status`. `rig.sh` never touches Twilio.

`rig.sh start` then brings the bridge up and opens the Funnel; `status`
prints whether the local port answers and whether the public hostname
does — the second is the one Twilio's connect depends on, and it has been
seen to lag a restart by a minute. Twilio's Alerts page is where a call
that "just got busy" explains itself (`64102`: it could not reach the
socket).

**Placing a call.** Save the number in your phone as `<number>,<pin>` and
dial it: the comma is a two-second pause, the digits are the PIN as DTMF,
and the call opens in silence until they are accepted — then Aiva says
hello and names the agents. (A trailing `#` is redundant — the PIN is
exactly eight digits — and harmless: the ninth keypress purges the hello
at Twilio, and the engine re-asks, #54.) The bridge log shows the whole
thing, shape only:

```
webhook path=/voice          Twilio asked how to answer; relay TwiML, no greeting
relay connected
frame kind=setup             the socket is up (~0.4 s after /voice)
frame kind=key ×8            the PIN, never its digits
command type=text last=true  Aiva's hello and the picker
frame kind=speech final=true "Hearth"
alert kind=session_started   agent, contextId — the row in the registry gains its agent
command type=text …          the agent's reply, one token per chunk, last on the final one
turn latency                 per turn: toFirstChunkMs (the agent), toFirstTokenMs (what Twilio got)
alert kind=session_ended     durationMs
call latency                 median and p90 of both, over the call's turns, and whether warm_up was on
webhook path=/action         reason=goodbye (or completed, or failed:64105 for a drop)
```

The stopwatch starts at the finalized prompt. `toFirstTokenMs` is what the
operator waits through; `toFirstChunkMs` is the agent's share of it. With
`"warm_up": true` (the default) the bridge sends the agent a context-only
message the moment it is chosen, so its subprocess is up before the first
question; set it `false` for the comparison the vertical slice asks for.

**Without a phone: the synthetic operator.** The `phone-test` MCP server
(`.mcp.json`; `thicket phone-test-mcp`) is the operator's seat as tools —
the phone's `slack-test`. `phone_call` places a real self-call whose
caller leg is its own ConversationRelay session (the rig allow-lists the
bridge's number for exactly this), keys the PIN post-dial, and retries
when the Funnel edge refuses — which it does often in the minutes after
any funnel change (`11200`/`64102`; four of five runs on 2026-08-30 needed
attempt two). Then `phone_say`, `phone_await_reply` (the assertion most
checks reduce to — match distinctive words, the transcript is Flux hearing
a TTS voice), `phone_press` / `phone_enter_pin`, `phone_status`,
`phone_transcript` (digits always `########`), `phone_hangup`.

It needs its own 0600 config, `~/.config/thicket/phone-test.json`
(`apps/cli/src/phone-test/config.ts` is the schema; the server refuses to
start without it, naming the path) — the Twilio credentials, the number,
the PIN, and the Funnel origin. Its recordings land in the real state dir
(`~/.local/state/thicket/phone-test/recordings/`), spike-format, ready for
`thicket phone-test redact`; the PIN appears in none of it. The
`/operator` funnel path it answers on is opened by `rig.sh` and shown by
`status` as `funnel-op`.

**The scripted suite.** `thicket phone-test run all` (or one name from
`thicket phone-test list`) drives the same leg through scripted scenarios
with assertions on what was heard, and exits non-zero saying what was
heard instead. This is the live check a phone change runs before landing:

| scenario | proves |
|---|---|
| `dial-string-pin` | the saved contact's post-dial PIN opens the door |
| `keypad-pin` | the PIN keyed by hand authenticates the same way |
| `wrong-pin` | three wrong PINs are refused, the third ends the call |
| `pick-and-ask` | an agent named by voice answers a real question |
| `drop-and-resume` | a call dropped mid-task is offered back, task intact |
| `barge-in` | interrupting three turns running leaves the session answering |
| `goodbye` | the wrap-up: Aiva answers it and the bridge ends the call |
| `turns-20` | a twenty-turn session holds; operator-side latency summarised |
| `unlisted-caller` | the silent drop — skipped until a second caller identity exists |

Assertions match distinctive words, never sentences (the transcript is
Flux hearing a TTS voice), and the first utterance of a call may arrive
clipped on this leg. Each call leaves one PIN-free recording;
`thicket phone-test redact <recording>` turns one into a fixture for
`tests/fixtures/conversationrelay/`.

What the tool cannot check stays human: how it *sounds*. And what it
cannot do is fail the caller gate — its calls authenticate — so the
refusal path (`caller_rejected`, unlisted number) is the fake-relay
integration tests' job until a second caller identity exists.

**Reading the registry.** Every call the bridge saw, with why it ended:

```sh
sqlite3 ~/thicket-test/state/thicket/phone/phone.db \
  'select call_sid, direction, agent, end_reason, ended_ms - started_ms as ms from calls order by started_ms desc limit 5'
sqlite3 ~/thicket-test/state/thicket/phone/phone.db 'select * from sessions'
```

`sessions` is what the next call is offered back — one row per agent, the
contextId that doubles as the Claude session id.

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
tail -f ~/thicket-test/phone.log
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
- **Hearing the call.** The log proves what was sent to Twilio, and the
  caller-leg peer (`spikes/conversationrelay/operator.ts`, #50 — the rig
  allow-list includes the bridge's own number so its self-calls authenticate)
  proves what was transcribable on the line. Whether it *sounds* right — the
  greeting audible, a reply not clipped, the voice bearable for an hour — is
  still heard, not read.

## Rules

- Never run `provision`. It mutates a live Slack workspace against a Tier 1
  rate limit, and manifest changes need a browser reinstall no automation can
  perform. Change the renderer, land it, and say in the commit that a
  provision is owed.
- Never push, never open a PR, never touch a remote.
- If a live check fails in a way the code cannot explain, prefer adding the
  missing log line over guessing. Every mystery in this project so far ended
  at a path that recorded nothing.
