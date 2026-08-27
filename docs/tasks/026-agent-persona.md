---
id: "026"
title: Agent persona — an appended system prompt per agent
status: done
component: packages/roster
language: typescript
depends_on: ["002"]
blocks: ["016", "022"]
parallel_safe: true
---

# Agent persona

## Context

Two features want the same thing and neither can have it yet.

Reactions (016) are only worth building if the agent uses them *well* —
situationally, with variance, not the same 👀 on every message. That is not a
tool signature, it is instruction.

Routines (022) need the agent to understand that silence is a valid and
usually correct outcome. Left to its defaults, a model asked to check a
changelog will find something to say every single time.

Both are behaviour, and behaviour comes from the prompt. The Agent SDK's
`Options` takes a system prompt, and the roster is where per-agent
configuration already lives. Nothing currently sets one.

The vision already anticipates the shape of this: *"Specialization within a
boundary comes from skills, `CLAUDE.md`, and the tools installed in that
account."* An appended system prompt is the smallest version of that idea, and
the one thicket can own directly — see task 027 for the larger one.

## Scope

- A per-agent prompt appendix **inline in `agents.yaml`** as a block scalar,
  threaded through to the session's options. Appended, never replacing: the
  harness's own prompt is what makes Claude Code work. Inline keeps one source
  of truth; move it to a file only if it outgrows a paragraph or two.
- Long enough to be useful, short enough to stay in `agents.yaml` — a
  paragraph or two, not a document. Anything larger belongs in `CLAUDE.md`
  (task 027).
- Where it interacts with generated Slack copy: the agent's description and
  suggested prompts are already rendered from its skills, and the persona
  should read as the same character.

## Open questions

- Interaction with `CLAUDE.md` in the account, which the agent also reads.
  Two places to say the same thing is two places for them to disagree.

## Acceptance criteria

- [x] An agent's persona reaches its session's system prompt, appended.
- [x] Changing it takes effect on the next session without redeploying.
- [x] A roster with no persona behaves exactly as today.

## What live verification established (2026-08-27)

`persona:` on the agent entry threads to the session as
`systemPrompt: { preset: claude_code, append }` — appended, never
replacing. agentd re-reads `agents.yaml` at every session spawn (falling
back to the startup persona if the file goes unreadable), which is what
makes the second criterion true without any restart:

- With `persona: Begin every reply with exactly the phrase 'Hearthside:'`,
  a DM answered `Hearthside: 4.`
- Edited live to an end-phrase habit, no restart: the next thread's
  session answered `6\n\n— the hearth keeps burning.`
- Removed, no restart: the next thread answered a bare `10`.

On the open question: the division of labour is persona for *behaviour*
(a paragraph, owned by the roster) and the account's CLAUDE.md for
*workspace instruction* (task 027). They meet in the model's context
either way; keeping behaviour out of CLAUDE.md is convention, not
mechanism.

## Live verification

See [LIVE-TESTING.md](LIVE-TESTING.md) for the rig and the `slack-test` MCP
tools. `slack_dm_agent` then `slack_await_reply`: a
persona instructing a recognisable habit should show up in the answer.

## Out of scope

Per-thread or per-turn prompt injection. Anything that lets a Slack message
edit the system prompt — that is a prompt-injection surface, not a feature.
