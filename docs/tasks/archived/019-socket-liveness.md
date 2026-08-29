---
id: "019"
title: Detect a Socket Mode connection that stops delivering
status: done
component: apps/bridge
language: typescript
depends_on: ["009"]
blocks: []
parallel_safe: true
---

# Detect a Socket Mode connection that stops delivering

## Context

Twice during live testing a DM produced nothing at all — no reply, no status
change, no log line — and both times a bridge restart fixed it. Both were
preceded by `A pong wasn't received from the server before the timeout` from
`@slack/socket-mode`, and the first occasion ended with the client's
`disconnected` event about an hour later, which the supervisor did handle.

The gap is the hour in between. `ConnectionSupervisor` reconnects on the
client's terminal `disconnected` event, which fires only after the library
exhausts its own retries. A socket that is open but no longer delivering
looks healthy the whole time: `connectedCount` says 1, nothing is logged,
and messages are lost silently.

What the second occurrence then established: **the messages are not lost,
they are stalled.** The DM that appeared to vanish at 05:42 ran in full at
05:48:18, six minutes later, once the bridge reconnected — Slack had held the
unacked event and redelivered it. The 04:31 window was about an hour on the
same pattern.

That lowers the severity and sharpens the fix. This is a latency bug, not a
delivery bug: an agent that answers six minutes late has already lost the
conversation, and an hour is indistinguishable from being down. Recovery does
not need to be invented, only triggered sooner.

## Scope

- Establish what the client actually reports when the socket goes quiet:
  which events fire, whether `ping`/`pong` failures are observable, and how
  long the library retries before giving up.
- Treat sustained silence as down. A liveness signal the supervisor can act
  on — last-event timestamp, consecutive pong failures, or the library's own
  ping loop — rather than waiting for the terminal event.
- Reconnecting must be cheap and safe to do spuriously: a redundant
  reconnect costs a websocket, a missed message costs a conversation.
- `thicket doctor` should be able to report the connection as unhealthy
  rather than merely present.

## Acceptance criteria

- [x] A socket that stops delivering is detected without waiting for the
      library's terminal `disconnected`.
- [x] The bridge reconnects on its own and logs why.
- [x] A message sent during the dead window arrives within seconds of
      recovery rather than minutes, and the delay is visible in the log.

## What the client actually reports (established from installed source)

`@slack/socket-mode@2.0.7`, read at
`node_modules/.pnpm/@slack+socket-mode@2.0.7`:

- Its own ping loop finds a dead socket in seconds: a ping every
  `clientPingTimeout/3` (~1.7s), and after >3 unanswered pings it logs the
  observed `A pong wasn't received…` warning and closes the socket. The
  close surfaces as a `close` event on the client, followed by
  `reconnecting`/`connecting`, and `connected` again on recovery. Detection
  was never the gap.
- The hour-long stall lives in `retrieveWSSURL()`: reconnecting fetches a
  fresh wss URL via a WebClient constructed with
  `retryConfig: {retries: 100, factor: 1.3}`. Failures retry *inside* the
  WebClient — invisible to every event listener, uncancellable, and with
  exponentially growing sleeps (minutes-long by the tenth attempt, an hour
  in aggregate is unremarkable). During this the client emits nothing and
  `disconnect()` cannot interrupt it.
- Library log output goes to its own console logger unless a logger is
  injected; the pong warning was only ever visible because stderr was
  captured.

The fix follows: inject our logger (the library's warnings now land in the
bridge's structured log with agent context), bound the hidden retries
(`retries: 3`) so failures surface to the library's observable outer
reconnect loop, and hold a recovery deadline — any `close`/`error`/
`reconnecting` must reach `connected` within 60s or the whole client is
abandoned (`abandoning socket mode connection` + reason in the log), the
supervisor then rebuilding a fresh one with its usual backoff. The initial
`start()` gets the same deadline so a hung first connect cannot wedge a
supervisor slot. Slack redelivers the unacked events on the next
connection — observed live on 05:48:18 during the second incident — and
each inbound event now logs `ageMs` (and `retryNum` when set), so a
redelivered message shows exactly how long it sat.

Verified by driving a fake client through dead-socket, healthy-reconnect,
hung-start, and redelivery scenarios (`socket.test.ts`), and live against
the rig: DM answered in ~5s with `ageMs: 298` logged, no spurious
abandonment on a healthy connection. The bridge also heartbeats per-agent
connection state to `state/bridge/health.json` every 15s, and
`thicket doctor` reports each connection up/down/stale from it.

## Live verification

See [LIVE-TESTING.md](../LIVE-TESTING.md) for the rig and the `slack-test` MCP
tools. Reproducing a dead socket on demand is the hard
part: prefer driving the supervisor and a fake connection over waiting for
Slack to misbehave. A live check that a healthy socket is *not* falsely
reported down is worth more than trying to stage the failure.

## Out of scope

Replacing Socket Mode. Slack's Events API over HTTP needs a public request
URL, which the vision rules out.
