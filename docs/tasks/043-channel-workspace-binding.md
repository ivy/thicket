---
id: "043"
title: Project channels know their workspace
status: todo
component: apps/bridge
language: typescript
depends_on: ["006", "009", "044"]
blocks: []
parallel_safe: false
---

# Project channels know their workspace

## Context

A project channel should mean a working directory. In `#proj-homestead`,
"fix the backup timer" should start a session already inside the homestead
checkout — where that repo's own `CLAUDE.md`, skills, and memory make the
agent know exactly what a local Claude Code session would know. The binding
is configuration, not a memory system: no new store, no summaries. The
workspace **is** the channel's memory, and Slack-you and laptop-you see the
same context.

Two-level indirection keeps host paths out of the bridge: the bridge knows
channel → (agent, workspace *name*); the agent's own config knows name →
path. Both halves render from `agents.yaml`. Precedent: Slack thread
coordinates travel in message metadata once 044 lands.

## Scope

- Roster schema: per-agent `workspaces: { name: path }` and channel
  bindings (channel → workspace name). Whether the operator writes channel
  IDs or names is an implementation decision — IDs don't drift, names are
  readable; whichever is stored, the config the operator writes should be
  the readable one.
- Bridge: on a message in a bound channel, include the workspace name in
  the message metadata alongside the existing thread coordinates.
- agentd/executor: resolve the name against the agent's rendered config and
  launch or resume the session with that cwd. An unknown name refuses the
  turn with a clear in-thread error — never a silent fall-back to `$HOME`.
- `contextId` derivation is untouched: binding a channel must not orphan its
  existing threads.
- DMs and unbound channels keep today's behaviour: the harness cwd from
  `agents.yaml`.

## Acceptance criteria

- [ ] A mention in a bound channel runs in the workspace cwd — observed by
      asking the agent for its cwd and for a fact only that repo's
      `CLAUDE.md` contains.
- [ ] DMs and unbound channels are unchanged.
- [ ] A binding to an undeclared workspace name fails loudly in-thread.
- [ ] A thread that existed before its channel was bound still resumes with
      its context.

## Live verification

Bind a test channel to a scratch repo whose `CLAUDE.md` holds a sentinel
("the codeword is heliotrope"). Ask in-channel for the codeword; then ask in
a DM and expect ignorance.

## Out of scope

Per-channel default-responder policy when several agents share a channel —
mention the one you want. Per-thread workspace overrides. Any channel-scoped
memory store beyond what the workspace repo itself holds.
