---
id: "018"
title: Materialize attachments into the agent's cache
status: in-progress
component: packages/executor
language: typescript
depends_on: ["017"]
blocks: []
parallel_safe: false
---

# Materialize attachments into the agent's cache

## Context

Task 017 makes the bytes fetchable and puts a `url` part in the message. This
task is what an agent does with one: stream it into its own filesystem and
tell the model where it landed.

Fetching is eager, not lazy. A file you attached is a file you expect to be
used — making the model spend a tool call to discover it can read something
you already handed it is friction with no payoff. Eager streaming is also
memory-bounded regardless of size, so the 1 GB case is merely slow rather than
impossible.

The fetch leaves through netd's egress socket, which dials only via `ts.Dial`.
A URL arriving in an inbound message therefore cannot reach the public
internet, localhost, or a cloud metadata endpoint: the SSRF question is
answered by the transport rather than by an allowlist that would have to be
maintained and trusted.

## Scope

- An `AttachmentStore` in `packages/executor`, injected like everything else
  there, that streams a `url` part into
  `$XDG_CACHE_HOME/thicket/attachments/<contextId>/` — cache, because the
  bridge can always re-serve the file, which is what makes discarding it safe.
- Filenames are attacker-controlled: basename only, separators and control
  characters stripped, length capped, with a URL-derived directory so two
  uploads named `report.csv` cannot collide and a re-fetch is idempotent.
  Directories `0700`, files `0600`.
- Inject the resulting paths ahead of the user's text, with type and size, so
  the model reads the attachment as context and the user's words as the
  instruction.
- A per-agent `attachments: accept | reject` policy on the roster harness. The
  vision says untrusted ingest never reaches privilege; an agent holding root
  should be able to refuse files at the door rather than relying on the
  operator to remember.
- A fetch that fails never fails the turn: the model is told the attachment
  could not be retrieved and can say so.
- An egress fetch adapter: HTTP CONNECT through netd's unix socket, then TLS.
  Agent-to-agent A2A needs the same adapter, so it belongs somewhere shared
  rather than inside the attachment path.
- Prune the cache by age and total size.

## Acceptance criteria

- [ ] An attached file lands in the agent's cache and its path reaches the
      model with type and size.
- [ ] A hostile filename cannot escape the attachment directory.
- [ ] Re-delivering the same attachment does not re-download it.
- [ ] An agent configured to reject attachments never fetches, and says so.
- [ ] A failed fetch degrades to a note in the prompt; the turn still answers.
- [ ] Cache pruning bounds the directory without operator intervention.

## Out of scope

Lazy fetch behind an MCP tool (see 016 — it becomes nearly free once that
surface exists, and is worth having only for files too large to want eagerly).
