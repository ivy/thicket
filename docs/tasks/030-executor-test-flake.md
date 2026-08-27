---
id: "030"
title: Executor attachment tests flake under the workspace test run
status: in-progress
component: packages/executor
language: typescript
depends_on: ["018"]
blocks: []
parallel_safe: true
---

# Executor attachment tests flake under the workspace test run

## Context

Observed twice (iterations landing 020 and 021): `pnpm test` fails with the
same three tests cancelled —

```
not ok 26 - an attached file is fetched and its path leads the prompt
not ok 27 - an agent that refuses attachments never fetches, and says so
not ok 28 - a failed fetch degrades to a note; the turn still answers
failureType: 'cancelledByParent'
error: 'Promise resolution is still pending but the event loop has already resolved'
```

Running the same file directly (`node --test dist/executor.test.js`) passes
all 59, every time. The failure appears only under `pnpm -r test` with the
workspace building and running in parallel, which suggests the tests hold a
promise whose resolution depends on a timer or I/O that can be starved —
the same event-loop-drain shape as an unref'd timer, not an assertion bug.

## Scope

- Find what those three tests leave pending (executor.test.ts, the
  attachment fetch path) and make its resolution deterministic.
- The fix belongs in the tests or their harness unless it exposes a real
  race in `attachments.ts` — in which case that is the fix.

## Acceptance criteria

- [ ] Five consecutive `pnpm test` runs pass with zero cancelled tests.
- [ ] The root cause is written down: what was pending, and why only the
      parallel run exposed it.

## Out of scope

Reworking the test runner or the workspace layout.
