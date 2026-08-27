---
id: "003"
title: netd — tsnet transport shim
status: done
component: netd
language: go
depends_on: ["001"]
blocks: ["012"]
parallel_safe: true
---

# netd — tsnet transport shim

## Context

`netd` holds an agent's tailnet identity so that `agentd` never binds a network socket.
It runs one embedded Tailscale node per agent account using `tsnet`, which needs no
root, no TUN device, and no separate `tailscaled`.

This exists to close a specific gap: loopback is not user-isolated on Linux, so any
local account can reach a `127.0.0.1` listener regardless of tailnet ACLs. Proxying from
tsnet into a mode-0600 unix socket removes that path entirely rather than mitigating it.

Written in Go solely because `tsnet` is Go-only. It must stay a dumb pipe — see
Out of scope.

## Scope

One binary, both directions, configured from the agent's XDG config.

**Node setup.**

```go
s := &tsnet.Server{
    Dir:           stateDir,                  // ~/.local/state/thicket/tsnet
    Hostname:      cfg.Hostname,              // e.g. "hearth"
    AuthKey:       cfg.AuthKey,               // must own the advertised tag
    AdvertiseTags: []string{cfg.Tag},         // e.g. "tag:thicket-hearth"
}
```

**Inbound.** `s.ListenTLS("tcp", ":443")`, reverse-proxy to the `agentd` unix socket.
For each request call `lc.WhoIs(ctx, r.RemoteAddr)` and set a peer header from
`who.Node.Tags`.

**Outbound.** Listen on a second unix socket as an HTTP forward proxy; dial upstream
through `s.Dial`. This is how `bridge` and peer agents make A2A calls with the correct
tailnet identity rather than the host's.

**Header hygiene.** Delete every inbound `X-Thicket-*` header before setting your own.
A caller that can set its own peer tags defeats the entire authorization model.

**Lifecycle.** Graceful shutdown on SIGTERM. Log to stderr for journald. Exit non-zero
with a clear message when the auth key does not own the configured tag.

## Acceptance criteria

- [x] Given a valid auth key and tag, the node joins the tailnet, comes up owning the
      configured tag, and is reachable over the tailnet. Verified against an in-process
      control server (`testcontrol`); reachability at the real
      `https://<hostname>.<tailnet>.ts.net/` with a valid TLS certificate requires live
      tailnet credentials and is verified during task 013's first-agent bring-up.
- [x] Requests arriving over the tailnet are proxied to the unix socket and the response
      is returned unmodified.
- [x] The peer header on the proxied request equals the caller's tags as reported by
      `WhoIs`.
- [x] A request that arrives carrying `X-Thicket-Peer-Tags` has that value discarded;
      the header `agentd` receives reflects only the `WhoIs` result. Covered by a test.
- [x] Outbound: an HTTP request through the egress socket reaches a peer tailnet node
      and the peer's `WhoIs` reports this node's tag.
- [x] `agentd`'s unix socket is never exposed on any TCP port by `netd`.
- [x] SIGTERM drains in-flight requests before exit.

## Out of scope

`netd` does not parse A2A, inspect task state, serve agent cards, or make
authorization decisions. It reports verified peer identity and moves bytes. Adding
protocol awareness here means maintaining two A2A implementations in two languages.

## References

- `tsnet.Server` fields and methods: https://pkg.go.dev/tailscale.com/tsnet
- `tailcfg.Node.Tags []string` is the peer tag list returned via `WhoIs`
