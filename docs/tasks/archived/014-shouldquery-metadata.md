---
id: "014"
title: Honor shouldQuery metadata end to end
status: done
component: packages/executor
language: typescript
depends_on: ["005", "008", "009"]
blocks: ["013"]
parallel_safe: true
---

# Honor shouldQuery metadata end to end

## Context

Task 009's bridge delivers non-mention thread messages with
`metadata["thicket.shouldQuery"] = false` so the agent gains context without
responding. Task 005's executor predates that contract: it builds every
`SDKUserMessage` without `shouldQuery`, so agentd currently starts a full turn
for a message the bridge intended as context-only. The A2A protocol itself has
no context-only send, so the metadata key is thicket's extension and both ends
must agree on it.

## Scope

- In `packages/executor`, read `metadata["thicket.shouldQuery"]` from the
  inbound A2A message in `ClaudeAgentExecutor.execute`. When `false`:
  - set `shouldQuery: false` on the outgoing `SDKUserMessage`;
  - do not register a pending send with the translator (no turn will answer
    it);
  - publish a task event that immediately completes (state `completed`,
    metadata noting it was context-only) so the A2A caller gets a well-formed
    response instead of a hang.
- Define the metadata key once, exported from `packages/executor`, and update
  `apps/bridge` to import it rather than duplicating the literal.
- Same treatment for `priority` ("thicket.priority" → `SDKUserMessage.priority`)
  while the seam is open — the bridge exposes it and the executor drops it
  today.

## Acceptance criteria

- [x] An executor test: a message with `thicket.shouldQuery: false` produces an
      `SDKUserMessage` with `shouldQuery: false`, no turn registration, and an
      immediately-completed task event.
- [x] A session-manager-level assertion already exists (task 006) that
      `shouldQuery: false` sends do not trigger a turn; it keeps passing.
- [x] The bridge and executor share one exported constant for the metadata key;
      grep shows no duplicated string literal.
- [x] `thicket.priority` maps onto `SDKUserMessage.priority` and is covered by
      a test.

## Out of scope

Bridge policy about *which* messages are context-only (decided in task 009).
Slack anything.
