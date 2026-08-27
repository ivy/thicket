---
id: "008"
title: agentd — A2A server daemon
status: in-progress
component: apps/agentd
language: typescript
depends_on: ["002", "004", "005", "006"]
blocks: ["012", "013"]
parallel_safe: false
---

# agentd — A2A server daemon

## Context

One `agentd` per unix account. It serves that agent's A2A endpoint, wires the executor
and session manager together, and persists tasks. It runs behind `netd` and has no
network listener of its own.

Most of the protocol is provided by `@a2a-js/sdk/server` — `DefaultRequestHandler`,
the Express adapter, the agent-card handler, `DefaultPushNotificationSender`. This task
is assembly plus authorization, not protocol implementation.

## Scope

**Transport.** Listen on a unix socket, preferring systemd socket activation (accept
the listening fd from `LISTEN_FDS`) and falling back to creating the socket at
`$XDG_RUNTIME_DIR/thicket/agentd.sock` with mode 0600. Never open a TCP port.

**Wiring.** `DefaultRequestHandler` with the task 004 store, the task 005 executor, and
the task 006 session manager. Serve the agent's card from task 002 at
`/.well-known/agent-card.json` with `Cache-Control` and an `ETag` derived from the card
version, per A2A §8.6.

**Authorization.** Read the peer tag header that `netd` sets and check it against an
allow-list in the agent's config. Reject unknown or absent peers with an A2A-shaped
error. `agentd` trusts this header precisely because it is only reachable through
`netd`, which strips client-supplied copies — assert at startup that the socket is not
world-accessible.

**contextId.** Accept a client-supplied `contextId` and use it (the bridge derives one
deterministically). Mint one when absent.

**Startup reconciliation.** Tasks left in `working` or `submitted` by a previous process
are not recoverable — their subprocess is gone. Transition them to `failed` with a
message saying the daemon restarted, so clients are not left polling forever.

**Operations.** Structured JSON logs to stderr. Graceful SIGTERM: stop accepting, let
in-flight turns settle within a timeout, terminate pooled subprocesses, exit.

## Acceptance criteria

- [ ] `curl --unix-socket <path> http://local/.well-known/agent-card.json` returns the
      agent's card with an `ETag`; a conditional request returns 304.
- [ ] A full `SendMessage` round trip over the socket produces a task that reaches a
      terminal state and is retrievable via `GetTask` afterwards.
- [ ] `SendStreamingMessage` yields incremental artifact events before the terminal
      status event.
- [ ] A request whose peer tag is absent, or not in the allow-list, is rejected — and
      the rejection is an A2A error object, not an unhandled 500.
- [ ] A client-supplied `contextId` is honored and appears on the resulting task.
- [ ] Restarting the daemon with a task in `working` leaves that task `failed`, never
      `working`.
- [ ] Socket activation path and self-created-socket path both work; the self-created
      socket is mode 0600.
- [ ] `CancelTask` interrupts a running turn and the task reaches `canceled`.
- [ ] SIGTERM leaves no orphaned `claude` subprocesses.

## Out of scope

Slack. Manifest generation. The tailnet — `netd` owns it (task 003).
