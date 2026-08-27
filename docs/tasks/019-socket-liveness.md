---
id: "019"
title: Detect a Socket Mode connection that stops delivering
status: todo
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

Not yet proven, and worth saying so: the first occurrence predates inbound
event logging, so "Slack never delivered it" and "the bridge dropped it"
were indistinguishable. Logging now separates those, and the next occurrence
should settle it. This task exists because the second occurrence recovered on
a fresh connection while the old one still claimed to be up.

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
- [ ] A message sent during the dead window is either delivered after
      recovery or visibly reported as lost — never silently dropped.

## Out of scope

Replacing Socket Mode. Slack's Events API over HTTP needs a public request
URL, which the vision rules out.
