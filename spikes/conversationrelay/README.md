# ConversationRelay spike

Scratch code for [#19](https://github.com/ivy/thicket/issues/19): a peer that speaks
Twilio ConversationRelay well enough to record what actually happens on the wire.
Nothing here ships or survives into `apps/phone`; the recordings it produced live in
`tests/fixtures/conversationrelay/` and the answers in `docs/reference.md`.

## Run

From the repo root, with the Funnel open on the public port and `.env` loaded:

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg 8799
set -a; . ./.env; set +a
SPIKE_PATH_SECRET=$(cat ~/thicket-test/spike-cr/secret) \
  mise exec -- bun spikes/conversationrelay/server.ts
```

`server.ts` listens on `127.0.0.1:8799` (public, behind Funnel) and `127.0.0.1:8798`
(control, local only). The number's voice URL is `$THICKET_PUBLIC_BASE_URL/voice`,
set over REST; its status callback is `/status`; `<Connect action>` is `/action`.
Every inbound and outbound frame, every webhook, and every socket event is appended
to `~/thicket-test/spike-cr/recordings/<CallSid>.jsonl`.

Signatures are checked on the webhooks (403 otherwise). On the WebSocket handshake
the spike instead records which candidate URL string the `X-Twilio-Signature` matched.

## Driving a call

By voice or keypad from the caller's side (`server.ts`: `VOICE_COMMANDS`,
`KEY_COMMANDS`), or from the control port while a call is up:

| Say | Press | `POST :8798 {"cmd": …}` | What happens |
|---|---|---|---|
| "long" | 1 | `long` | a 12-sentence reply, every token queued at once — talk over it |
| "busy digits" | 2 | `busy-digits` | the long reply, then `sendDigits` 3 s in |
| "drop" | 3 | `drop` | the socket is terminated without a close frame |
| "malformed" | 4 | `malformed` | ten non-JSON frames are sent |
| "end session" | 5 | `end` | `end` with `handoffData`; `/action` then answers per `nextAction` |
| "preempt" | 6 | `preempt` | the long reply, then a `preemptible` message 3 s in |
| "send digits" | 7 | `digits` | `sendDigits` `1234#` now |
| "silence" | | `silence` | one short reply, then nothing |
| anything else | any other key | `{"cmd":"text","text":"…"}` | echoed back as streamed tokens |

`{"cmd":"action","twiml":"hangup"|"say-hangup"|"reconnect"|"dial"}` chooses what
`/action` returns next; `{"cmd":"twiml","attrs":{…}}` overrides `<ConversationRelay>`
attributes for the next call; `GET :8798/` shows the current call.

`call.ts` is a synthetic caller: Twilio dials the number from itself and the caller
leg runs a script of `<Say>`, `<Play digits>` and `<Pause>`, so most of the
observations need no person on the line:

```sh
mise exec -- bun spikes/conversationrelay/call.ts pin        # or greeting-dtmf, silence,
                                                             # interrupt, busy-digits,
                                                             # preempt, hold
```

## The caller leg (#50)

`operator.ts` is the other half of a self-call: the number dials itself, the caller
leg runs its own `<Connect><ConversationRelay>` pointed here, and this process is
the operator — it hears the bridge's leg as `prompt` text, speaks with `text`
tokens, keys digits, and hangs up. The rig's bridge answers the inbound leg for
real (the rig allow-list includes the bridge's own number), so this is how a whole
authenticated session runs with nobody on the phone.

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg --set-path /operator 8797
set -a; . ./.env; set +a
mise exec -- bun spikes/conversationrelay/operator.ts
```

Control port `127.0.0.1:8796`: `GET /` is status plus the two-sided transcript;
`POST {"cmd":…}` drives it — `call` (`pin`: `dial` | `dial-late` | `none`,
`hash:false` drops the trailing `#`, which otherwise barges in on the hello — #54),
`say {text}`, `pin` (keys the PIN as DTMF; only its digit count is ever recorded),
`digits`, `end`, `rest-hangup`, `attrs`, `clear`. Funnel strips the `/operator`
mount prefix before proxying, and the edge can refuse a call minutes after a
reconfig (11200/64102 while HTTP probes pass) — probe via public DNS with
`curl --resolve`, and retry busy calls.

## Fixtures

`redact.ts` turns a recording into a fixture: SIDs, numbers, the account, and the
public host are replaced with stable stand-ins, timestamps are kept.

```sh
mise exec -- bun spikes/conversationrelay/redact.ts ~/thicket-test/spike-cr/recordings/CA….jsonl \
  > tests/fixtures/conversationrelay/<name>.jsonl
```
