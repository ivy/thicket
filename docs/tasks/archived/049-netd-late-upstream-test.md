---
id: "049"
title: netd's tolerance of an absent agentd is untested
status: done
component: netd
language: go
depends_on: ["047"]
blocks: []
parallel_safe: true
---

# netd's tolerance of an absent agentd is untested

## Context

[047](archived/047-socket-activation-after-bun.md) removed
`thicket-agentd.socket` and, with it, every ordering edge between netd and
agentd. What makes that safe is a property of `newInboundProxy`: it dials
agentd's unix socket once per request rather than once at startup, so a
request arriving before agentd exists returns 502 and the next one is served.

That property is now load-bearing — `deploy/README.md` cites it as the reason
there is nothing to order — and nothing in the test suite defends it. It was
observed once, by hand, with a throwaway test that was deleted:

```
PROBE before the socket exists: status=502
PROBE after the socket appears: status=200
```

A refactor that hoisted the dialer, or a transport that cached a failed
connection, would break the deployment model and pass every test.

## Scope

- A test in `netd/proxy_test.go` that starts an inbound proxy against a
  socket path that does not exist, asserts 502, then creates the upstream and
  asserts the next request is served — with no restart of the proxy in
  between.

## Acceptance criteria

- [x] The test exists and passes, and fails if the dial is hoisted out of
      `DialContext`.

## Out of scope

Changing netd's behaviour. Retry or wait semantics — the 502 is the contract
[047](archived/047-socket-activation-after-bun.md) documented, not a
shortcoming.

## Verified (2026-08-29)

`TestInboundProxyServesOnceTheUpstreamAppears` passes against the current
proxy. Hoisting the dial to construction — `net.Dial` once, the result handed
back from `DialContext` — makes it fail on the half that matters:

```
proxy_test.go:196: status once the upstream appeared = 502, want 200
```

so the test is anchored to the property rather than to the 502 alone, which a
hoisted dial would still produce.
