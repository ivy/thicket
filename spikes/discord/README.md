# Discord spike

Scratch code for the Discord bridge: a peer that holds one Gateway connection
through the egress socket, records every frame on the wire, and runs the
scenarios the design doc needs observed rather than assumed. Nothing here ships
or survives into `apps/discord`. `redact.ts` turns the recordings into the
fixtures in `tests/fixtures/discord/`; the answers are in `docs/reference.md`
and the design they shaped in `docs/discord-bridge.md`.

Every outbound leg goes through `SOCKET`, the same CONNECT proxy a deployed
bridge gets from netd. There is no direct-dial path, so a leg that works here
works from a bridge with no network of its own; with a bad token the spike
still reaches Discord and is told `401`.

## Before running: mint the application

One application per agent, in a Team, so the fleet lives in one place. For the
spike, one is enough.

1. <https://discord.com/developers/teams> → **New Team**. Two-factor auth is required.
2. <https://discord.com/developers/applications> → **New Application**, owned by the
   Team. The name becomes the bot's username. Note the **Application ID** on the
   General Information page.
3. **Bot** tab:
   - **Reset Token**, copy it once. It is never shown again.
   - **Public Bot** off, so nobody else can install it.
   - **Privileged Gateway Intents**: turn on **Message Content**. Under 10,000
     users this is a toggle, not an application. Leave Presence and Server
     Members off.
4. The install URL, by hand, since a private application cannot carry a default
   install link: `https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot+applications.commands&permissions=309304855616`,
   the permission set [docs/discord-bridge.md](../../docs/discord-bridge.md)
   lists. Open it, pick a test server you own, authorize.
5. In Discord, **User Settings → Advanced → Developer Mode** on, then right-click
   the server → **Copy Server ID**, and a text channel → **Copy Channel ID**.

Put them in `.env` at the repo root (gitignored, beside the Twilio values):

```sh
DISCORD_BOT_TOKEN=…
DISCORD_APP_ID=…
SPIKE_GUILD_ID=…
SPIKE_CHANNEL_ID=…
```

## Run

From the repo root. The egress stand-in is the dev `netd` (plain TCP, no
tailnet bound; never anywhere real):

```sh
mkdir -p ~/thicket-test/run/thicket
SOCKET=~/thicket-test/run/thicket/spike-egress.sock mise exec -- bun deploy/dev/egress-proxy.mjs &
set -a; . ./.env; set +a
SOCKET=~/thicket-test/run/thicket/spike-egress.sock mise exec -- bun spikes/discord/spike.ts
```

`SPIKE_INTENTS=nocontent` identifies without the Message Content intent, for the
visibility recordings. Everything is appended to
`~/thicket-test/spike-discord/recordings/<scenario>.jsonl`; `scenario` switches
the file. The bot token is redacted in the recordings; everything else waits for
`redact.ts`:

```sh
mise exec -- bun spikes/discord/redact.ts ~/thicket-test/spike-discord/recordings tests/fixtures/discord
```

## Driving it

Two ways. Type `!<command>` in any channel the bot can see, and the command runs
with that channel as its target. Or `POST 127.0.0.1:8795 {"cmd": "…"}`, which
targets `SPIKE_CHANNEL_ID`. `GET /` shows the session.

Any other human message is echoed back as a reply with how many characters of
content arrived, whether the bot was mentioned, and how many files came with it
— so the content-intent rules are observed, not read.

| Command | What it records |
|---|---|
| `scenario <name>` | switches the recording file |
| `card` | a Components V2 turn card: status, steps, streamed text, a Stop button |
| `question` | the question flow: a select for the quick answer, **Answer in full…** opens a modal with radio, checkbox, text, and file upload; **Approve** answers ephemerally |
| `stream [seconds]` | edits one V2 message once a second, recording `X-RateLimit-*` on every edit and any 429 |
| `burst [n]` | edits as fast as the API allows, to find the per-channel edit bucket |
| `limit [start]` | grows one Text Display by 1000 chars until refused; the error body is the limit |
| `limit-split [n]` | two Text Displays of `n` chars: per-component or per-message? |
| `upload` | a file through a hand-built multipart body, shown with a File component |
| `thread [name]` | a thread from a message; records whether the ids are equal |
| `post <id> <text>` | posts into any channel or thread id, including one another bot started |
| `archive <threadId>` | archives, then posts: does the post unarchive it? |
| `typing` | the typing indicator |
| `nick [name]` | per-guild nickname and bio |
| `presence [text]` | a custom status over the gateway |
| `commands` | registers `/spike`, which defers and then edits `@original` |
| `disconnect` | terminates the socket without a close frame: the zombie path, which must end in a resume |
| `reconnect` | a clean close, then resume |
| `fresh` | drops the session so the next connect identifies anew |
| `status` | session, connection, intents |

## The observation list

What each spike is for, and where the answer goes.

**Gateway through egress.** `ready` records the connect host and the
`resume_gateway_url` host. If they differ, netd's `egress_allow` needs the
resume host too, and by name — a per-region host is a wildcard. `disconnect`
and `reconnect` must both end in `RESUMED` with the missed dispatches replayed.

**Payload fixtures.** With `scenario dm` and so on: a DM, a mention in a
channel, an unmentioned follow-up in a thread with and without the content
intent, a reply with and without the ping, a message with an attachment, thread
creation, and one of each interaction. These become `translate.test.ts` inputs.

**The streamed turn.** `stream 60`, watched on the phone and the desktop
client: does an edit a second flicker or re-notify, and what do the headers say
the budget is. `limit` and `limit-split` settle the Text Display total. `burst`
finds the edit bucket.

**The question flow.** A modal opens only as the response to an interaction, so
an agent question is a message with a button that opens it. Judge the two-step.

**REST unknowns.** `upload` through `egressFetch`; `nick` and `presence`;
`post` into a thread the other bot started; `archive` for how long a context
stays reachable.
