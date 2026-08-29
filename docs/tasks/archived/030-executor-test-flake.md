---
id: "030"
title: Executor attachment tests flake under the workspace test run
status: done
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

- [x] Five consecutive `pnpm test` runs pass with zero cancelled tests.
- [x] The root cause is written down: what was pending, and why only the
      parallel run exposed it.

## Root cause (2026-08-27)

The three attachment tests synchronized with a fixed 20ms sleep between
starting `execute()` and pushing the fixture frames:

```
const running = executor.execute(ctx, stubBus(events));
await new Promise((r) => setTimeout(r, 20));   // hope execute() got far enough
session.queue.push(...withUuid(fixture, "uuid-1"));
await running;                                  // hangs when it didn't
```

`execute()` runs the attachment preamble — an HTTP fetch and disk writes —
*before* `registerSend`. On an idle machine that takes under 20ms; under
the parallel workspace run it can take longer, so the frames arrived
while no send was registered, the translator dropped them
(`turn bound to unknown user_message_uuid … ignoring`), and the turn's
`done` promise never resolved. With nothing else on the event loop, the
runner cancelled the test (`Promise resolution is still pending but the
event loop has already resolved`) and its two siblings with it — which is
why the failure list always started at the first attachment test.

The fix removes the timing dependency: the tests now wait for the send to
appear in the fake session (`untilSent`), which by construction happens
after `registerSend`, so the frames always find their turn. The
production code needed no change — the race lived entirely in the tests'
sleep.

## Out of scope

Reworking the test runner or the workspace layout.
