---
id: "019"
title: Detect a Socket Mode connection that stops delivering
status: in-progress
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

- [ ] A socket that stops delivering is detected without waiting for the
      library's terminal `disconnected`.
- [ ] The bridge reconnects on its own and logs why.
- [ ] A message sent during the dead window arrives within seconds of
      recovery rather than minutes, and the delay is visible in the log.

## Live verification

See [LIVE-TESTING.md](LIVE-TESTING.md) for the rig and the `slack-test` MCP
tools. Reproducing a dead socket on demand is the hard
part: prefer driving the supervisor and a fake connection over waiting for
Slack to misbehave. A live check that a healthy socket is *not* falsely
reported down is worth more than trying to stage the failure.

## Out of scope

Replacing Socket Mode. Slack's Events API over HTTP needs a public request
URL, which the vision rules out.
