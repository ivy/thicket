---
id: "006"
title: Session manager — hot/cold Claude Code sessions
status: done
component: packages/executor
language: typescript
depends_on: ["002"]
blocks: ["008"]
parallel_safe: true
---

# Session manager — hot/cold Claude Code sessions

## Context

The Agent SDK spawns the Claude Code CLI as a subprocess; one live `query()` is one
process. Holding a process open per active thread does not scale, and starting one per
turn pays session-reload latency on every message.

Hot/cold splits the difference: keep a session's process alive for a configurable idle
window, then let it exit and resume from its session ID on the next message. Slack
threads arrive in bursts and then go quiet, which is exactly the shape this suits.

Shares a package with task 005 but no files — coordinate on the module boundary before
starting.

## Scope

**Session identity is derived, not stored.**

```ts
sessionId = uuidv5(`${channel_id}:${thread_ts}`, THICKET_NAMESPACE)
```

The same value is the Agent SDK `sessionId` and the A2A `contextId`. The SDK accepts a
caller-supplied session ID ("Use a specific session ID for the conversation instead of
an auto-generated one. Must be a valid UUID"), so no mapping table is needed.

**Streaming input mode is mandatory.** `query()` accepts
`string | AsyncIterable<SDKUserMessage>`. Only the async-iterable form supports the
control requests (`interrupt`, `setPermissionMode`, `setModel`) — the SDK's own types
say these are "only supported when streaming input/output is used". Keep a per-session
generator open and push messages into it.

**Message shaping.** Two `SDKUserMessage` fields carry real weight:

- `shouldQuery: false` — "the message is appended to the transcript without triggering
  an assistant turn. It will be merged into the next user message that does query."
  Use this for thread messages the agent should see but not respond to.
- `priority: 'now' | 'next' | 'later'` — expose it; task 009 decides policy.

**Lifecycle.**

- Warm start: session in the hot pool, push to the existing generator.
- Cold start: no live process, spawn with `resume: sessionId`.
- Idle eviction after `harness.sessionTtlSeconds` (roster field, default 300). Close the
  generator, let the process exit, keep nothing but the ID.
- Never evict a session with a turn in flight.
- Bounded pool with a configurable max; evict least-recently-used beyond it.

**Process hygiene.** `env`, when set, *replaces* the subprocess environment entirely
rather than merging — pass through `PATH`, `HOME`, and credentials deliberately. Set
`cwd` from the roster entry.

## Acceptance criteria

- [x] The same `(channel_id, thread_ts)` yields a byte-identical session ID across
      processes and restarts.
- [x] A message to a hot session reuses the existing subprocess — asserted by process
      identity, not by timing.
- [x] A message to an evicted session resumes prior context: a fixture conversation
      establishes a fact, the session is evicted, and a follow-up turn recalls it.
- [x] Idle eviction fires at the configured TTL and not before.
- [x] A session with an in-flight turn is not evicted when its TTL expires; eviction
      happens after the turn settles.
- [x] Pool cap is enforced; exceeding it evicts LRU rather than refusing work.
- [x] `shouldQuery: false` messages appear in the next turn's context without having
      triggered a turn of their own.
- [x] Subprocess environment contains only what was explicitly passed, and includes
      `PATH` and `HOME`.
- [x] SIGTERM to the host process terminates all pooled subprocesses; no orphans.

## Out of scope

Translating the resulting stream to A2A events (task 005). Deciding *when* a message
should set `shouldQuery: false` — that policy lives in the bridge (task 009).
