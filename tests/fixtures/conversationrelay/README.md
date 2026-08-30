# ConversationRelay recordings

Real calls, recorded on the wire by the M0 spike (`spikes/conversationrelay/`,
[#19](https://github.com/ivy/thicket/issues/19)) on 2026-08-30 with
`transcriptionProvider="Deepgram" speechModel="flux" partialPrompts="true"
dtmfDetection="true" interruptible="any" reportInputDuringAgentSpeech="any"
events="speaker-events tokens-played"` and a `welcomeGreeting`. The caller on every
recording is Twilio itself — the number dialled from the same number, the caller leg
running `<Say>`, `<Play digits>` and `<Pause>` — so the speech is a TTS voice on a
clean line, not a person in a car.

One JSON object per line, in arrival order, each with the wall-clock `t` and `ms`
since the spike started. `dir` says what it is:

| `dir` | Holds |
|---|---|
| `http` | a webhook Twilio called (`/voice`, `/action`, `/status`, `/gather`) with its form, or the TwiML we answered with |
| `ws` | the WebSocket handshake (headers, which signature candidate matched) and close (code, reason) |
| `in` | a frame Twilio sent over the socket, verbatim under `frame` |
| `out` | a frame we sent, under `frame` (or `raw` when deliberately malformed) |
| `note` | what the spike decided to do and why |

Identifiers are stand-ins of the real shape: SIDs are numbered (`CA…0001` is the
relay leg in every file), numbers are `+1555010000N`, the account is all zeros, the
public host is `phone.example.net`, the path secret is `fixture`, and city/state/zip
fields are blank. Nothing else was altered.

| File | The call |
|---|---|
| `pin-spoken.jsonl` | the greeting; an 8-digit test PIN spoken as words; a sentence; caller hangs up |
| `greeting-dtmf.jsonl` | a keypress during the greeting and one after it |
| `interrupt.jsonl` | a long streamed reply, the caller talking over it |
| `idle-digits.jsonl` | `sendDigits` with nothing playing; the caller leg's `<Gather>` reports what it heard and when |
| `queued-digits.jsonl` | a short reply, then `sendDigits` a second later — the tones wait for the speech |
| `busy-digits.jsonl` | a long reply with `sendDigits` fired 3 s in; the `<Gather>` times out first |
| `talking-digits.jsonl` | `sendDigits` while the caller is speaking |
| `preempt-queued.jsonl` | a long reply, then a message flagged `preemptible` 3 s in — it queued and played last |
| `preempt-marked.jsonl` | the long reply itself flagged `preemptible`, then a plain message 3 s in |
| `end-then-say-hangup.jsonl` | `end` with `handoffData`; `action` answers `<Say><Hangup/>` |
| `end-then-reconnect.jsonl` | `end`; `action` answers a fresh `<Connect><ConversationRelay>`; a second session on the same CallSid |
| `socket-drop.jsonl` | our side terminates the socket without a close frame |
| `malformed-frames.jsonl` | ten non-JSON frames |
| `rest-update-completed.jsonl` | the call ended from the REST side (`Status=completed`) |
| `long-silence.jsonl` | 88 s of nothing from either side, then speech |
