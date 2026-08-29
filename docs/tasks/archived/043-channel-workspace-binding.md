---
id: "043"
title: Project channels know their workspace
status: done
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

- [x] A mention in a bound channel runs in the workspace cwd — observed by
      asking the agent for its cwd and for a fact only that repo's
      `CLAUDE.md` contains. 2026-08-28, dev roster binding `#thicket-test`
      to `scratch: ~/thicket-test/workspaces/scratch` (a `CLAUDE.md` saying
      the codeword is heliotrope): mentioned there, hearth answered `pwd` =
      `/Users/ivy/thicket-test/workspaces/scratch` and "heliotrope". The
      bridge asked `conversations.info` exactly once for the channel.
- [x] DMs and unbound channels are unchanged. Same question in the DM:
      `pwd` = `/Users/ivy/thicket-test/agent-home`, "no codeword".
      `engine.test.ts`: DMs and unbound channels carry no workspace and
      cost no Slack call.
- [x] A binding to an undeclared workspace name fails loudly in-thread.
      With agentd reading a roster copy that declares no workspaces while
      the bridge's binding names `scratch`, a mention in the channel got,
      in-thread: "I can't take this one: this channel is bound to a
      workspace I don't have — workspace "scratch" is not declared for
      this agent (it declares none). Fix the roster (agents.yaml) and try
      again." Nothing ran. (Both halves in one file are caught earlier:
      the roster refuses a binding to an undeclared name at parse time.)
- [x] A thread that existed before its channel was bound still resumes with
      its context. The `#thicket-test` thread from 044's live check, engaged
      in the harness cwd before the binding: asked for its marker word and
      its cwd, hearth answered "periwinkle" and
      `/Users/ivy/thicket-test/workspaces/scratch`. (An SDK probe first
      showed a session started in one cwd resumes, memory intact, from
      another.)

## Live verification

Bind a test channel to a scratch repo whose `CLAUDE.md` holds a sentinel
("the codeword is heliotrope"). Ask in-channel for the codeword; then ask in
a DM and expect ignorance.

## Out of scope

Per-channel default-responder policy when several agents share a channel —
mention the one you want. Per-thread workspace overrides. Any channel-scoped
memory store beyond what the workspace repo itself holds.

## Dev rig

The binding used for the live check is not left in the dev roster — later
live checks in `#thicket-test` would otherwise run in the scratch
workspace without saying so. To bind it again, under `hearth` in
`~/thicket-test/config/thicket/agents.yaml`:

```yaml
    workspaces:
      scratch: /Users/ivy/thicket-test/workspaces/scratch
    channels:
      "#thicket-test": scratch
```

then `./deploy/dev/rig.sh restart`. The workspace directory and its
`CLAUDE.md` are still there.
