---
id: "020"
title: Agent Slack toolbelt — an MCP surface over the bridge API
status: in-progress
component: apps/agentd
language: typescript
depends_on: ["017"]
blocks: ["016", "021", "022"]
parallel_safe: false
---

# Agent Slack toolbelt

## Context

Task 017 built a bridge-side HTTP API and proved the authorization pattern:
netd verifies the caller's tailnet identity, the tag names the agent, and the
bridge answers *may this agent do this?* from its own state. That gave agents
one capability — fetch a file. Everything else an agent might want to do in
Slack is another route on the same surface.

Exposing those to the model is separately cheap: the Claude Agent SDK's
`createSdkMcpServer` runs an MCP server **in the same process** as agentd,
with tools defined as async functions and zod schemas. No subprocess, no
binary, no deployment unit — and no Slack credential anywhere near the agent.

Two capabilities are wanted immediately and are the right pair to build the
substrate around: an agent that can **post** where it was not spoken to
(routines, task 022), and one that can **hand back a file** it produced.

## Scope

- An in-process MCP server in agentd, wired into `Options.mcpServers`,
  reachable by the session and by nothing else.
- Bridge routes behind the existing peer-tag authorization, each answering
  the authorization question from bridge state rather than from the request.
- First tools: `post_message(channel, text)` and `upload_file(path, ...)`.
- Files go out **as a tool call, not as an A2A artifact**. Decided: Claude
  Code can only produce an artifact by calling a tool anyway, so the artifact
  path would add a second mechanism with no second capability. Revisit when a
  harness without MCP joins the fleet.
- Every tool call is authorized against what the agent may address. An agent
  must not be able to post into a channel its app is not in, and the bridge —
  not the agent — decides that.
- Failures are the model's to handle: a tool returns a structured error the
  model can act on, rather than throwing and failing the turn.

## Open questions

- **Rate limits.** `chat.postMessage` is Tier 3 and shared with the bridge's
  own traffic. A chatty agent must not starve the conversation it is in.
- **Loop safety.** An agent posting into a channel it also watches can
  trigger itself. The bridge already drops `bot_id` messages, which covers
  the simple case; a delegate posting under another agent's identity
  (task 023) does not have that protection.

## Acceptance criteria

- [ ] An agent can post a message and upload a file without holding a Slack
      credential.
- [ ] An agent cannot address a channel it has no business in, and the
      refusal is the bridge's decision.
- [ ] A tool failure reaches the model as a usable error, not as a dead turn.

## Live verification

See [LIVE-TESTING.md](LIVE-TESTING.md) for the rig and the `slack-test` MCP
tools. Ask the agent to post into `#thicket-test`
and read it back with `slack_history`; ask it to hand back a file and check
the attachment with `slack_thread`. The refusal path matters as much: ask it
to post somewhere it has no business and confirm the bridge declines.

## Out of scope

Reactions (016), workspace search and history (021), and routines (022) —
all of which are routes and tools on top of this.
