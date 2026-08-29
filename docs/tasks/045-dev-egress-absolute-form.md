---
id: "045"
title: The dev egress stand-in refuses what netd accepts
status: todo
component: deploy
language: none
depends_on: ["012"]
blocks: []
parallel_safe: true
---

# The dev egress stand-in refuses what netd accepts

## Context

Observed during 044's live check (2026-08-28): `thicket mcp` and `thicket
fleet` cannot reach the dev rig. The CLI's egress door
(`apps/cli/src/mcp/http.ts`, `egressHttp`) sends `http:` targets through
the proxy as absolute-form requests and opens a `CONNECT` tunnel only for
`https:`. netd's real egress proxy (`netd/proxy.go`, `newEgressProxy`)
accepts both forms, so that is fine in production. The development
stand-in (`deploy/dev/egress-proxy.mjs`) accepts `CONNECT` only and
answers everything else with `405 Method Not Allowed` — which the CLI
reports as "agent returned HTTP 405 with a non-JSON body".

agentd's `egressFetch` tunnels everything, `http:` included, so the
toolbelt reaches the dev bridge through the same stand-in and nobody
noticed until the CLI was pointed at the rig.

## Scope

- `deploy/dev/egress-proxy.mjs` accepts absolute-form `http:` requests —
  dial the target named in the request line, forward the request, relay
  the response — alongside `CONNECT`, matching netd's contract.
- A non-proxy request (an origin-form path) still gets a clear 4xx, as
  netd gives one.
- LIVE-TESTING.md's rig section says the CLI can be pointed at the rig
  with `THICKET_MCP_ENDPOINTS` and `THICKET_EGRESS_SOCKET`, and shows the
  two-line incantation.

## Acceptance criteria

- [ ] With the rig up, `thicket fleet` with `THICKET_MCP_ENDPOINTS`
      naming the local agentd and `THICKET_EGRESS_SOCKET` naming the
      stand-in reports the agent up.
- [ ] `thicket mcp`'s `ask` completes a turn against the rig through the
      stand-in.
- [ ] agentd's toolbelt still reaches the bridge through it (a
      `post_message` live).

## Out of scope

Changing `egressHttp` to tunnel `http:` — netd accepts absolute-form, and
the stand-in is what disagrees with netd. Anything in `netd/`.
