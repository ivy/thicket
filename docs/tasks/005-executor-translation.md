---
id: "005"
title: Executor — Agent SDK stream to A2A task events
status: done
component: packages/executor
language: typescript
depends_on: ["002"]
blocks: ["008"]
parallel_safe: true
---

# Executor — Agent SDK stream to A2A task events

## Context

This is the protocol seam: `@anthropic-ai/claude-agent-sdk` emits a stream of
`SDKMessage`, and `@a2a-js/sdk` expects `TaskStatusUpdateEvent` and
`TaskArtifactUpdateEvent` published to an `ExecutionEventBus`. Every subtlety in the
system lives here.

It is a separate package so it can be tested against recorded SDK streams with no
daemon, no subprocess, and no network.

## Scope

Implement `AgentExecutor` from `@a2a-js/sdk/server`:

```ts
interface AgentExecutor {
  execute(requestContext, eventBus): Promise<void>
  cancelTask(taskId, eventBus): Promise<void>
}
```

**Turn boundaries are not message boundaries.** The SDK coalesces queued sends: its
docs state that queued sends "may coalesce into fewer turns, so this counts pending
sends, not remaining results." Derive one A2A `Task` per *turn result*, not per inbound
message, and record on the task which inbound message IDs were folded into it.

**Join key.** Stamp each outbound `SDKUserMessage` with a `uuid`. The SDK echoes it as
`user_message_uuid` on the turn's **first reply frame only** and on the result. Use it
to bind replies to the request that caused them; do not assume later frames carry it.

**State mapping.** Emit `TaskStatusUpdateEvent` on these transitions:

| SDK signal | A2A `TaskState` |
|---|---|
| turn started | `working` |
| result, `subtype: "success"` | `completed` |
| result, error subtype | `failed` |
| interrupted / aborted | `canceled` |
| agent asked a question and stopped | `input-required` |

`input-required` and `auth-required` are interrupted states, not terminal — do not
close the task on them.

**Streaming.** Emit `TaskArtifactUpdateEvent` with `append` and `lastChunk` set so a
consumer can render progressively. Assistant text deltas append to one artifact per
turn; set `lastChunk: true` on the final chunk.

**Queue depth.** Surface `queued_turn_count` from the result message in the terminal
`TaskStatusUpdateEvent` metadata. Task 009 uses it to decide whether to release the
Slack session status.

**Cancellation.** `cancelTask` maps to the SDK's `interrupt()`. Feature-detect via
`capabilities` on the `system/init` message rather than version-sniffing:

- `interrupt_receipt_v1` — the interrupt response carries `still_queued`
- `interrupt_cancel_queued_v1` — the request honors `cancel_queued: true`

With `cancel_queued: true` the response lists cancelled uuids under `cancelled` and
`still_queued` is empty. Older CLIs behave as if `false`, leaving queued work to run;
handle both. Per-message cancellation uses `cancel_async_message` by uuid.

**Errors.** A crashed subprocess must produce a `failed` task with a usable message, not
a hung task. Never leave a task in `working` when the stream ends.

## Acceptance criteria

- [x] Golden tests over recorded `SDKMessage` streams (fixtures checked in) produce the
      expected sequence of A2A events. Fixtures cover at minimum: a plain turn, a turn
      with tool use, a streaming text turn, an error result, an interrupted turn, and
      two sends coalescing into one turn.
- [x] The coalescing fixture yields **one** task, and that task records both inbound
      message IDs.
- [x] `user_message_uuid` is read from the first reply frame; a fixture where later
      frames omit it still binds correctly.
- [x] `queued_turn_count` from the result appears in the terminal status event.
- [x] Artifact events set `append`/`lastChunk` such that concatenating chunks
      reconstructs the full assistant text exactly.
- [x] `cancelTask` on a CLI advertising `interrupt_cancel_queued_v1` cancels queued
      sends; on one that does not, the executor reports what remains queued rather than
      claiming everything stopped.
- [x] A stream that ends without a result yields `failed`, never a task stuck in
      `working`.
- [x] No test in this package spawns a subprocess or opens a socket.

## Out of scope

Owning subprocess lifecycle (task 006). Slack concepts — this package must not import
anything Slack-related or know that Slack exists.

## References

- `@anthropic-ai/claude-agent-sdk` type definitions (`sdk.d.ts`) are authoritative for
  `SDKMessage`, `Query`, and the control-request shapes.
- A2A task lifecycle: `docs/topics/life-of-a-task.md` in `a2aproject/A2A`.
