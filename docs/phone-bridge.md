# Phone bridge

The design the phone milestones (`M0`–`M3` on the board) assume. It states what the
bridge is and where its edges are; the issues say what to build next. The facts under
*External facts* were read from the vendors' documentation on 2026-08-29 and are
**not yet verified live** — the M0 spike observes them and moves what it confirms into
[reference.md](reference.md).

## What it is

A voice console to the fleet for the operator on the road. The operator dials one
number; Aiva — the bridge's own voice — authenticates them with an 8-digit PIN, asks
which agent they want and whether to resume a previous session, and from then on the
call is a conversation with that agent: tasks given by voice, answers and progress
spoken back, a dropped call resumable from the next one. Every session start and end,
and every failed PIN, is posted to a security-alerts channel in Slack.

It is **not** a screener of strangers. Nobody but the operator gets past the greeting,
and the agents reachable from it can be privileged ones — root included — because the
caller is the operator, authenticated. That is the line the roster draws explicitly
(`phone.enabled` per agent) and the ACL enforces (the bridge's tag may call
phone-enabled agents; only Twilio, through Funnel, may reach the bridge).

## Shape

`apps/phone` (`thicket-phone`) is a second bridge, built like the Slack one: it
translates Twilio ConversationRelay's JSON into `message/send` on the right agent and
carries task events back, runs in its own unix account behind its own netd, and talks
to Twilio directly — as the Slack bridge talks to Slack. Nothing in `packages/executor`
or `apps/agentd` knows what a phone is; the runtime learns a few metadata keys and a
preamble line. The one thing this bridge holds that the Slack bridge does not is
authentication policy, because Slack authenticates the operator and the PSTN cannot.

```
operator ─PSTN─► Twilio ─wss (text JSON)─► netd Funnel ─► thicket-phone ─A2A over tailnet─► netd ─► agentd ─► session
                   │  Flux STT · TTS · barge-in · DTMF          │   greeting → PIN → picker → connected
                   └─action webhook (after the session)─────────┘   alerts ─► Slack #security-alerts
```

Only Twilio ever handles audio. Everything to the right of it is text.

| Owner | Responsibility |
|---|---|
| Twilio Voice | PSTN, the number, call state, digit sending |
| Twilio ConversationRelay | speech → text (Deepgram Flux), text → speech, barge-in and DTMF detection, turn boundaries |
| netd (Funnel mode, M3; `tailscale funnel` on the rig) | the public listener; strips `X-Thicket-*`, stamps **no** peer tag |
| `thicket-phone` | signature verification, caller allow-list, PIN check and lockout, the picker, session ↔ call registry, relay JSON ⇄ A2A, speakable text, narrated progress, interrupt → cancel, resume, the `action` webhook's TwiML, security alerts, Twilio REST |
| `packages/executor`, `apps/agentd` | unchanged: session per contextId, frames → events, cancel, coalescing, journal |
| each phone-enabled agent's account | the work itself, and reporting to Slack through the toolbelt it already has |
| `agents.yaml` + `provision` | which agents answer, their spoken names, the number's voice URL |
| the bridge's 0600 config (never the roster) | the operator's numbers, the PIN, the alerts channel and token, the public base URL |

## The call

A deterministic state machine runs before any agent hears a word:

1. **greeting** — Aiva answers. A caller not on the allow-list hears a neutral line and
   the call ends; an alert is posted.
2. **authenticating** — the PIN, by keypad or spoken; three attempts, then a refusal;
   repeated failures from one number lock it out for a while. The utterance carrying the
   PIN is never logged, journaled, or forwarded.
3. **choosing** — Aiva names the phone-enabled agents; the operator names one; if a
   recent session with it exists, resume or start fresh. On resume, what the agent did
   meanwhile is read from the task store and spoken.
4. **connected** — each finalized prompt is one streamed A2A turn on the session's
   `contextId`; chunks become `text` tokens with the last held back to carry `last`;
   a barge-in is `cancelTask`; tool activity is narrated a beat at a time; "status",
   "repeat that", "send that to Slack", "switch agent", "goodbye" are handled here.
5. **ending** — the session-end alert with agent and duration; the session stays
   resumable; a task still running keeps running.

## Identity

Deterministic, following `deriveSessionId`:

- **A phone session** is `contextId = sessionId = uuidv5("phone:" + agent + ":" + CallSid of the call that opened it)`,
  recorded in the bridge's state with the agent and the operator, and reused by every
  later call that resumes it. It outlives calls on purpose.
- **messageId** `phone-{CallSid}-{seq}` — per call, so a resumed session's messages
  still say which call they came from.
- **taskId** agent-minted, one per utterance. A terminal task takes no more messages,
  so every turn is a new task in the session; only an `input-required` answer continues
  a task.

## Trust

- The PIN is the whole gate: caller ID is a pre-filter, never authority. It is a value in
  the bridge's 0600 config, written by the operator like every token, compared in
  constant time, and never logged.
- Alerts are the oversight surface: start, end, every failure, every lockout, every
  unlisted caller. Best-effort — a failed post never affects the call.
- The bridge is the first internet-facing component: Twilio's signature on every
  handshake, a secret path segment, Funnel's own TLS, shape-only logging. The public
  hostname was probed by scanners within seconds of appearing.
- Agents reachable from the phone are whatever the roster enables; a privileged agent
  on the phone is a deliberate roster line, reviewed like any other.

## The hedge

Build the bridge in two halves from day one: a *transport half* (the relay codec and
socket) and a *conversation half* (state machine, registry, A2A, alerts). If
ConversationRelay proves limiting — no `TurnResumed`, no `ForceEndTurn`, no mid-call
keyterms, three TTS vendors, an undocumented concurrency cap — the transport half is
replaced by Twilio Media Streams with our own Flux (`/v2/listen`) and TTS sockets, and
everything from the PIN onward is unchanged.

## External facts (documented, unverified live)

ConversationRelay (`<Connect action="…"><ConversationRelay url="wss://…" …>`):

- `speechModel="flux"` is **not** the default (`nova-3-general` is) and only exists under
  `transcriptionProvider="Deepgram"`. Flux knobs are `eotThreshold` (0.5–0.9, default
  0.8), `partialPrompts` (unfinalized transcripts *and* eager end-of-turn both arrive as
  `prompt{last:false}`, indistinguishable), `speechTimeout` (forwarded as a maximum
  silence). No `StartOfTurn` / `TurnResumed` message exists over the socket.
- Inbound: `setup`, `prompt{voicePrompt,lang,last}`, `dtmf{digit}` (one per keypress,
  needs `dtmfDetection="true"`), `interrupt{utteranceUntilInterrupt,durationUntilInterruptMs}`,
  `error{description}`; `agentSpeaking`/`clientSpeaking` with `events="speaker-events"`.
- Outbound: `text{token,last,lang?,interruptible?,preemptible?}` (stream tokens, `last`
  on the final one; `preemptible:true` replaces what is playing), `play`, `sendDigits`
  (`0-9 w # *` only), `language{ttsLanguage,transcriptionLanguage}`, `end{handoffData}`.
- `end` ends the relay leg, not the call; `action` decides what happens next. Our socket
  dropping fails the call — Twilio never reconnects. Ten malformed frames → close 1007.
- `X-Twilio-Signature` is on the WebSocket handshake; only the account's primary auth
  token validates it — an API key secret cannot. REST calls use a Restricted API key.
- `reportInputDuringAgentSpeech` defaults to `none` (was `any` before May 2025).
- Pricing: $0.07/min for ConversationRelay plus Voice ($0.0085/min inbound local);
  whether STT/TTS are bundled is unpublished.

Deepgram Flux (`wss://api.deepgram.com/v2/listen`; v1 does not serve Flux):

- Events `Update` (~0.25 s cadence, cumulative transcript), `StartOfTurn`,
  `EagerEndOfTurn` (opt-in via `eager_eot_threshold`), `TurnResumed`, `EndOfTurn`
  (`trigger: model | manual | timeout`). Invariant: the `EndOfTurn` transcript equals the
  preceding `EagerEndOfTurn` transcript, or `TurnResumed` came first.
- ~260 ms p50 end-of-turn detection at defaults; eager mode costs 50–70 % more LLM calls
  for ~100–200 ms. Deepgram's docs never mention ConversationRelay.

To be observed in M0: how a spoken 8-digit PIN transcribes; whether keypad digits during
the greeting arrive; what a long silence does to the session; `sendDigits` during
speech; whether an interrupt purges queued text; `UpdateCall Status=completed` versus
`action`; what a caller-side drop looks like and how fast; max call duration; the
concurrency default.

Sources: the Twilio and Deepgram pages listed in the planning artifact
(https://claude.ai/code/artifact/b4ad1b75-13bf-4bfe-b61b-b1d4e4bb7b18), chiefly
`twilio.com/docs/voice/conversationrelay/{conversationrelay-noun,websocket-messages,best-practices}`,
`twilio.com/docs/iam/api-keys/restricted-api-keys`, and
`developers.deepgram.com/docs/flux/{state,configuration,voice-agent-eager-eot}`.
