---
id: "028"
title: thicket send — reach an agent from a shell script
status: icebox
component: apps/cli
language: typescript
depends_on: ["011"]
blocks: []
parallel_safe: true
---

# thicket send

## Context

There are two ways to reach an agent today: type in Slack, or use the MCP
server from a local Claude Code session. Both assume a person or a model at
the other end. Nothing lets a shell script, a systemd timer, a git hook, or a
CI job say something to an agent.

That is a small gap with a large surface. `thicket send hearth "the backup
job failed"` turns every existing piece of automation on the operator's
machines into something that can talk to the fleet, without any of it knowing
what A2A is.

It is also the cheapest possible answer to a question routines (task 022)
otherwise own entirely: much scheduled work already has a scheduler, and
letting cron poke an agent is simpler than teaching the agent to be a cron.
The two are complements — routines are for work the agent decides to do,
`send` is for work something else already decided.

## Scope

- `thicket send <agent> <text>`, reusing the A2A client the MCP server already
  wraps. Stdin as an alternative to an argument, so pipelines work.
- Choose a mode deliberately: fire-and-forget (exit as soon as the task is
  accepted) versus wait-and-print (block, stream, exit on the terminal state).
  A script wants the first; a human at a terminal wants the second. Probably
  both, with a flag.
- A useful exit code, so a script can tell success from failure without
  parsing prose.
- Where the reply goes when nobody is watching. An agent answering a shell
  script into a void is worse than useless — it burns tokens and hides the
  answer. Routing the reply to a Slack DM is likely the right default.

## Open questions

- Which context. A fresh context per invocation is simplest and forgets
  everything; a named context lets a nightly script build a running
  conversation with its agent, which is either useful or a slow-motion context
  leak.
- Whether this belongs in the same binary as `provision` and `doctor`, which
  are operator tools, or somewhere lighter that a script can call without the
  provisioning machinery on the path.

## Acceptance criteria

- [ ] A shell script can send a message to an agent and get a meaningful exit
      code.
- [ ] Output is readable both piped and at a terminal.
- [ ] A reply is never silently discarded.

## Out of scope

A general HTTP API. That was considered and set aside for want of a concrete
use case; if one appears, it is its own decision.
