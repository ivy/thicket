---
id: "023"
title: Agent-to-agent delegation (research)
status: icebox
component: .
language: typescript
depends_on: ["020"]
blocks: ["048"]
parallel_safe: true
---

# Agent-to-agent delegation

**This is a research ticket. It ends in a written recommendation, not a
merge.**

## Context

The vision describes this and it is unbuilt:

> Agents reach each other directly when a task spans contexts. […] When an
> agent is working inside a Slack thread it passes the thread's coordinates in
> `Task.metadata`, so a delegate can post its own progress into that thread
> under its own identity. The human sees one conversation; the coordination
> never touches Slack.

It was blocked on an agent-side network path. That is no longer true: netd's
egress proxy is built and tested, and task 018 added a working CONNECT
adapter over it, so agentd can already reach the tailnet.

Delegation is also what turns *"untrusted ingest never reaches privilege"*
from a restriction into a capability. Today that principle only says what a
root-holding agent may not do. With delegation it can say: **do not read the
email yourself — ask the agent whose job that is, and act on its summary.**
The blast-radius boundary stops being a wall and becomes a division of labour.

## What to research

- **Prior art first.** A2A is a public protocol with a growing ecosystem, and
  multi-agent delegation is a well-trodden problem. Find what exists —
  reference implementations of A2A clients-inside-agents, discovery and
  routing by skill, delegation patterns with their failure modes — before
  designing anything. Report what is worth adopting and what is not, with
  reasons.
- **Discovery.** `AgentCard.skills[]` already exists and is generated from the
  roster. Is fetching cards enough to route by skill, or does something need
  to hold a fleet-wide view? A registry would contradict *"at run time there
  is no shared configuration file"*.
- **Identity of the delegate's output.** The vision wants the delegate posting
  under its own identity into the originating thread. That means thread
  coordinates in `Task.metadata` and a bridge route that posts as a *different*
  agent than the one being addressed — which is a new authorization question,
  since task 020 scopes an agent to what it may address.
- **Loops and depth.** A delegating to B delegating to A. What bounds it.
- **Failure semantics.** The delegate is unreachable, slow, or refuses. What
  the caller tells the human, and whether a partial answer is worth having.
- **The ACL direction.** The vision permits privileged agents to call ingest
  agents and not the reverse. Delegation must be expressible within that
  direction, and the design should say what happens when someone wants the
  reverse.

## Acceptance criteria

- [ ] A written recommendation: what to build, what to adopt, what to skip.
- [ ] An answer on discovery that does not reintroduce shared run-time config.
- [ ] The delegate-identity authorization question answered explicitly.
- [ ] Loop and depth bounds proposed.
- [ ] Follow-on implementation tasks filed with real scope.

## Out of scope

Building it. Anything that routes agent coordination through Slack — the
vision rules that out directly.
