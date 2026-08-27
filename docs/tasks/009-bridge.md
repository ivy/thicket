---
id: "009"
title: bridge — Slack Socket Mode to A2A
status: todo
component: apps/bridge
language: typescript
depends_on: ["002"]
blocks: ["013"]
parallel_safe: true
---

# bridge — Slack Socket Mode to A2A

## Context

One process holds a Socket Mode connection per agent app and translates between Slack's
agent surface and A2A. It is a pure A2A client: it never runs agent code, never touches
agent filesystems, and holds only Slack credentials.

It runs as its own unix account on the always-on host so that agents on sleeping
machines still get an honest answer in Slack rather than silence.

Can be built against a stub A2A server; does not need task 008.

## Scope

**Connections.** One Socket Mode connection per agent, opened with that app's app-level
token via `apps.connections.open`. Socket Mode means no public request URL and no
request-signature verification — the connection an event arrives on identifies the app.
Reconnect with backoff; a dropped connection must not drop the process.

**Thread to context.** Derive `contextId = uuidv5(channel_id + ":" + thread_ts)`, the
same derivation task 006 uses. Send it on every message.

Handle the disagreement case: the A2A spec has the *agent* mint `contextId`, and a
third-party agent may return one different from what was proposed. On mismatch, persist
the mapping and use the agent's value from then on. Derivation is the fast path, not an
invariant.

**Which messages trigger a turn.** In a channel, only `app_mention` and messages inside
a thread the agent is already engaged in should trigger. Other thread messages go to the
agent with `shouldQuery: false` so it has context without responding. In a DM, every
message triggers. Expose this as the `queueing` policy from the roster: `harness` sends
concurrently and lets the agent queue; `bridge` serializes per thread.

**Status mapping.** Drive `agents.sessions.setStatus` from A2A task state:

| A2A `TaskState` | Slack session status |
|---|---|
| `submitted`, `working` | `processing` |
| `completed` | `active` |
| `input-required` | `active` |
| `auth-required` | `suspended`, plus an auth link in-thread |
| `failed`, `rejected` | `active`, plus an error message in-thread |
| `canceled` | `active` |

Use `agents.sessions.setStatus` and `agents.sessions.rename` — `assistant.threads.*`
equivalents are deprecated. Note `processing` times out after one hour; re-assert it on
long tasks.

Hold `processing` when the terminal event's `queued_turn_count` is greater than zero —
more turns follow without further input.

**Streaming.** When the card advertises `capabilities.streaming`, map
`TaskArtifactUpdateEvent` onto `chat.startStream` → `chat.appendStream` →
`chat.stopStream`, keyed on `append` and `lastChunk`. Otherwise post one
`chat.postMessage` on completion.

**Stop button.** Subscribe to `agent_session_stopped` and issue A2A `CancelTask`. This
is the only correct handling — ignoring it leaves Slack showing a stopped session while
the agent keeps working.

**Unreachable agents.** A machine may be asleep. On connection failure, post a clear
message in-thread and queue the request; deliver when the agent's card becomes fetchable
again. Do not fail silently, and do not retry forever without telling the user.

**State.** Only in-flight tracking: `task_id → (channel_id, thread_ts, stream_ts,
agent)`. SQLite. This reverse index is what lets a task that finishes long after the
request land back in the right thread.

## Acceptance criteria

- [ ] Every row of the status mapping table has a test.
- [ ] A terminal event with `queued_turn_count > 0` leaves the session `processing`;
      with `0` it goes `active`.
- [ ] Streaming artifact events produce exactly one `chat.startStream`, N
      `chat.appendStream`, one `chat.stopStream`, and the concatenation matches the
      artifact text.
- [ ] An agent whose card lacks `capabilities.streaming` gets a single
      `chat.postMessage` and no stream calls.
- [ ] `agent_session_stopped` issues `CancelTask` for the in-flight task on that thread.
- [ ] A non-mention message in an engaged thread reaches the agent with
      `shouldQuery: false` and triggers no turn.
- [ ] With `queueing: bridge`, two rapid messages produce two sequential A2A calls;
      with `queueing: harness`, both are sent without waiting.
- [ ] An agent returning a `contextId` different from the derived one is recorded, and
      the next message in that thread uses the agent's value.
- [ ] An unreachable agent produces an in-thread notice and a queued request that is
      delivered on recovery.
- [ ] A dropped Socket Mode connection reconnects without restarting the process and
      without dropping other agents' connections.
- [ ] Restarting the bridge with a task in flight still routes that task's completion to
      the correct thread.

## Out of scope

Creating Slack apps (task 010). Running agent code. Anything requiring a bot token to
have filesystem or shell access.
