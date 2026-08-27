---
id: "004"
title: Durable A2A TaskStore
status: in-progress
component: apps/agentd
language: typescript
depends_on: ["001"]
blocks: ["008"]
parallel_safe: true
---

# Durable A2A TaskStore

## Context

`@a2a-js/sdk` defines a `TaskStore` interface and ships `InMemoryTaskStore`. In-memory
loses every task when `agentd` restarts, which breaks two things that matter: resuming a
long-running task after a deploy, and answering `GetTask` for work that outlived the
process.

This task implements a SQLite-backed `TaskStore`. It is isolated from the rest of
`agentd` so it can be built and tested against the SDK interface alone.

## Scope

- Implement `TaskStore` from `@a2a-js/sdk/server` over SQLite (`better-sqlite3` or
  `node:sqlite`).
- Store the full `Task`: `id`, `contextId`, `status`, `artifacts`, `history`,
  `metadata`. Persist `TaskStatus.timestamp`.
- Index on `contextId` so all tasks in a conversation are retrievable, and on
  `status.state` so in-flight tasks can be found after a restart.
- Support `ListTasks` filtering, since the SDK's request handler exposes it.
- Schema migrations: a versioned table plus a forward-only migration runner. First
  release is version 1.
- Retention: configurable pruning of terminal tasks older than N days, defaulting to
  keeping everything. Never prune non-terminal tasks.

## Acceptance criteria

- [ ] Passes a conformance suite exercising every `TaskStore` method, written so it can
      also be run against `InMemoryTaskStore` to prove the suite is testing the
      interface and not the implementation.
- [ ] A task written, then read after reopening the database, is deeply equal to the
      original — including artifacts and history.
- [ ] Tasks in `submitted` or `working` at startup are enumerable, so `agentd` can
      reconcile them (task 008 decides what to do with them).
- [ ] Concurrent writes from two connections do not corrupt state; WAL mode enabled.
- [ ] Migration runner takes an empty file to current schema, and is idempotent when
      run twice.
- [ ] Pruning removes only tasks in terminal states (`completed`, `failed`, `canceled`,
      `rejected`) — never `input-required` or `auth-required`, which are interrupted,
      not terminal.

## Out of scope

The bridge's own thread mapping store (task 009). Push notification config storage —
the SDK's `DefaultPushNotificationSender` is used as-is unless it proves insufficient.
