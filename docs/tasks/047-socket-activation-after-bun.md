---
id: "047"
title: systemd socket activation cannot survive the Bun port
status: in-progress
component: deploy
language: none
depends_on: ["040"]
blocks: []
parallel_safe: true
---

# systemd socket activation cannot survive the Bun port

## Context

`deploy/systemd/thicket-agentd.socket` owns agentd's unix socket and hands
it over as fd 3 with `LISTEN_FDS=1`. That solves ordering (netd can start
first) and lets agentd activate lazily.

Bun cannot accept it. `node:net` says so outright —

```
error: Bun does not support listening on a file descriptor.
  fd: 3, syscall: "listen", errno: 22, code: "EINVAL"
```

— while `node:http` resolves `listen({ fd })`, reports success, and then
never accepts a connection. Observed under Bun 1.4.0 on 2026-08-29, against
both a bare `http.createServer` and agentd itself: the daemon logs
`agentd listening … "target":"fd:3"` and answers nobody.

[040](archived/040-bun-port.md) made that refusal loud rather than silent —
`listen()` rejects the fd path with a message naming `LISTEN_FDS` — so a
misconfigured host fails at startup instead of going quiet. It did not
decide what the units should do instead, because that is a deployment
question with real consequences.

macOS already runs without activation: `com.thicket.agentd.plist` lets
agentd create its own 0600 socket, and has since 012.

## Scope

- Decide and implement how agentd gets its socket on Linux. The obvious
  candidate is what launchd already does — agentd creates it — which makes
  `thicket-agentd.socket` unnecessary and `Requires=`/`After=` in
  `thicket-agentd.service` wrong.
- Whatever ordering the `.socket` unit was solving has to be solved again:
  netd dials `%t/thicket/agentd.sock`, and with no unit owning it there is
  a window where the path does not exist. State plainly whether netd
  already retries, and if it does not, say which task owns that.
- The `.service` unit currently has no `[Install]` section because it was
  never meant to start directly. Without activation it needs one.
- If the decision is instead to keep activation, then agentd cannot run
  under Bun on Linux and 040's premise needs revisiting — write that down
  rather than leaving both halves in the tree.

## Acceptance criteria

- [ ] agentd on a systemd host serves on its socket after a plain
      `systemctl --user start`, with the unit files matching what actually
      happens.
- [ ] The ordering question is answered in `deploy/README.md`: what
      creates the socket, what happens to a caller that arrives first.
- [ ] `resolveListenTarget`'s fd branch and its refusal either still earn
      their place or are gone, with the reason in the commit body.

## Out of scope

Making Bun able to adopt a descriptor — that is upstream. The launchd side,
which already works this way.
