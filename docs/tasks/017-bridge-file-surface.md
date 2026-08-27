---
id: "017"
title: Bridge file surface — agents fetch attachments by tailnet identity
status: in-progress
component: apps/bridge
language: typescript
depends_on: ["009"]
blocks: ["018"]
parallel_safe: false
---

# Bridge file surface

## Context

An agent that cannot read the file you attached is an agent you have to work
around. Slack allows uploads up to 1 GB; in practice they are under 20 MB.

The obvious route — base64 the bytes into the A2A message as a `raw` part —
fails on a detail of this repo rather than on principle. `taskShell()` records
the inbound message in the task's `history`, and `SqliteTaskStore` persists the
task as JSON, so a 20 MB attachment becomes ~27 MB of base64 written into a
row, per turn, permanently. Raising `express.json`'s limit past that trades a
hard failure for a slow one.

The alternative is for the agent to fetch the bytes. Three things that would
have made that expensive turn out to already exist:

- **netd has a working egress proxy** — a second unix socket carrying outbound
  HTTP, dialed through `ts.Dial`, with an e2e test asserting the peer sees this
  node's tag (`netd/main.go`, `netd/e2e_test.go`). The agent host's outbound
  path is built.
- **netd is generic.** `Hostname`, `Tag`, and `UpstreamSocket` are all config
  fields and it "parses no A2A and makes no authorization decisions". Giving
  the bridge a tailnet identity is a `netd.json`, not a new component.
- **A2A `Part.content` already has a `url` arm.** Carrying a reference rather
  than bytes is the protocol working as designed, not an extension.

So the file never enters A2A. The message carries a `url` part pointing at the
bridge, with `filename`, `mediaType`, and size; the agent streams it down.

## The trust-graph cost

Today the bridge dials agents and nothing dials the bridge. This adds the
reverse edge, which means every agent — including ingest agents the vision
keeps away from privilege — can reach the process holding the Slack tokens.

That is a deliberate widening, and it is contained the same way agentd's is:
authorization is a peer-tag read plus a lookup in the bridge's own state
(*may this agent fetch this file? only if it was uploaded to a thread that
agent is in*). No token is minted, distributed, or rotated — the tailnet
identity netd already verifies is the credential. The surface stays one `GET`
with no writes.

## Scope

- Record uploads: `translateSlackEvent` carries `files[]`; the engine writes a
  descriptor (id, name, mimetype, size, private URL) into `BridgeState` keyed
  by agent and thread.
- Serve them: a unix-socket HTTP surface on the bridge with the same peer-tag
  authorization agentd uses, exposing `GET /files/:fileId`. The bridge streams
  from `url_private_download` with its bot token — bytes pass through, never
  buffer.
- Refer to them: outbound A2A messages gain a `url` part per attachment.
- Prune descriptors alongside the file cache's own retention.
- `files:read` in the manifest (a scope change, so a reinstall).
- A `netd.json` and deploy unit for the bridge's tailnet identity, and a
  development stand-in for the reverse direction so this is testable without a
  tailnet.

## Acceptance criteria

- [ ] An upload's descriptor is recorded and the outbound message carries a
      `url` part naming it.
- [ ] An authorized agent can stream the bytes; the response never buffers the
      file in memory.
- [ ] An agent cannot fetch a file from a thread it is not in, and an
      unauthenticated caller cannot fetch at all.
- [ ] With no reachable address configured, attachments degrade to a clear
      in-thread notice rather than a broken link.

## Out of scope

Materializing the file on the agent side (task 018). Agent-produced files
going the other way. Anything that puts a Slack token on an agent host.
