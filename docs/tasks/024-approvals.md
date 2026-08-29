---
id: "024"
title: Approvals — a permission prompt that reaches the operator
status: icebox
component: apps/bridge
language: typescript
depends_on: ["009"]
blocks: ["048"]
parallel_safe: true
---

# Approvals

## Context

A headless session has no permission prompt surface, so an `ask` decision is
a terminal denial. That was observed live: hearth was blocked on `vm_stat`,
`top`, and `sysctl` with "requires approval" and could do nothing about it.
The workaround was `permissionMode: auto`, which routes decisions through the
model classifier.

For a read-only agent that is fine. For the agent holding root — the one the
entire blast-radius principle exists to make possible — it is the wrong
answer. The point of a privileged account is that a human decides, and right
now the only two options are *a model decides* or *nothing happens*.

Most of the machinery is already in place. `deferred_tool_use` on a result
frame maps to `TASK_STATE_INPUT_REQUIRED` in the translator, and the bridge
already handles that state. What is missing is the half that reaches a phone:
Slack renders the request with buttons, the answer routes back, the turn
resumes.

Slack's interactive components work over Socket Mode, and `context_actions`
blocks are already in the manifest vocabulary — no request URL needed, so the
"never expose an HTTP endpoint" constraint holds.

## Scope

- Turn `input-required` into an actual Slack prompt: what is being asked, by
  which agent, on which host, with approve and deny.
- Route the click back as a follow-up that resumes the turn rather than
  starting a new one.
- A timeout that denies rather than hanging. An approval nobody answers must
  not leave a task in `working` forever.
- Make `permissionMode: default` genuinely usable headless, so the roster
  choice between "ask me" and "let the classifier decide" is real.

## Open questions

- **Who may approve.** In a one-operator workspace this is nearly moot, but
  the button is visible to anyone in the channel. A DM-only rule, or an
  allow-list of user ids, is probably the cheap correct answer.
- **Granularity.** Per tool call, or "allow this kind of thing for the rest of
  the session"? The latter is far more usable and far easier to regret.
- **Blast radius of the button itself.** An approval prompt is a place where a
  prompt injection would very much like to end up. What the agent controls in
  that message, and what it does not, needs to be explicit — the rendered
  request should be built by the bridge from structured fields, never from
  agent-supplied markup.

## Acceptance criteria

- [ ] A tool call needing approval reaches Slack as a prompt, not a dead turn.
- [ ] Approving resumes the same turn; denying returns a usable refusal.
- [ ] An unanswered approval times out and fails cleanly.
- [ ] An agent with `permissionMode: default` is useful headless.

## Out of scope

Replacing the classifier for agents that want it. Approval policy expressed as
rules rather than as a human decision.
