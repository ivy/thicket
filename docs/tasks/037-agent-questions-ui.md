---
id: "037"
title: Agent questions render as Slack UI, and a tap answers them
status: in-progress
component: apps/bridge
language: typescript
depends_on: ["014", "015"]
blocks: []
parallel_safe: true
---

# Agent questions render as Slack UI, and a tap answers them

## Context

When an agent asks the user something (AskUserQuestion), the session
pauses with a `deferred_tool_use` and the translator already maps it to
`TASK_STATE_INPUT_REQUIRED` — but the question reaches Slack only as
streamed prose, and the options inside it are just text. The human
answers by typing a reply, which works, but a question with three
options should be three buttons.

What already exists, so the work is the delta — and the SDK offers two
hook shapes for AskUserQuestion specifically:

- **The deferred path (build on this).** Observed 2026-08-28 against
  SDK 0.3.247, correcting what this file first claimed: with no
  `canUseTool` callback — thicket's situation until now — the tool is
  not deferred, it is *absent*: the init frame's tool list has no
  AskUserQuestion at all, and the agent says so when asked to use it.
  Register a `canUseTool` and the tool appears; a `PreToolUse` hook
  returning `permissionDecision: "defer"` for it then ends the turn with
  `terminal_reason: tool_deferred` and `deferred_tool_use: {id, name,
  input}`, `input` being the full structured payload (questions,
  headers, options, multiSelect). The session's next send is the answer
  — the model carried on with "staging" as the environment — and the
  next question defers again as long as the input stream stays open.
  The callback itself denies, which is what a headless `ask` already
  was. The translator maps the deferral to input-required and today
  discards the structure; this is why a button tap can reduce to the
  typed-reply path.
- **The live-dialog path (noted, not chosen).** The SDK also has
  `canUseTool`/`onUserDialog` callbacks: with one registered the
  question parks the *running turn* awaiting a structured answer, with
  `dialogExpiry` (default ~5m) resolving unanswered dialogs to a
  no-action default. Structured answers are nicer, but holding a turn
  open while a human notices Slack fights the session TTL, stream
  lifetimes, and chat's minutes-to-hours latency. Revisit only if the
  deferred path proves lossy; `askUserQuestionTimeout` exists if so.
- The manifest already enables `interactivity`, so `block_actions`
  payloads arrive over the existing Socket Mode connection — no
  provision owed.
- A typed reply in the thread already resumes the session; a button tap
  should reduce to the same thing.

## Scope

- **Make the question exist.** The session manager registers the
  permission surface (deny — nothing new is allowed) and the defer hook,
  so an agent can ask at all.
- **Carry the structure.** The translator surfaces the deferred tool's
  `input` (questions, options) as metadata on the input-required status
  event, alongside the prose it already emits.
- **Render it.** The bridge, on input-required with question metadata,
  posts a Block Kit message: the question as a section, options as
  buttons (or a radio group + submit for multi-select) with `action_id`s
  carrying the option value. See the block-elements reference below.
- **Handle the tap.** A new inbound event kind for `block_actions`
  envelopes over Socket Mode: verify the tapper is in the thread's
  conversation, ack, translate the choice into a normal message send in
  the same context (the same path a typed answer takes), and update the
  question message (`chat.update`) to show what was chosen and disable
  further taps.
- **Degrade honestly.** A workspace or surface where the blocks are
  rejected falls back to today's prose question; a tap arriving after
  the session moved on gets a gentle ephemeral/threaded note rather
  than a crash.

## Verification caveat (binding)

LIVE-TESTING.md: **clicking anything needs a human** — MCP servers post
and read, they do not synthesize interactions. The rendering and the
`block_actions` translation are unit/integration-testable (fake the
envelope); the end-to-end tap needs the operator. If implementing
unattended, finish everything testable, then end `blocked` per PROMPT §6
with exactly the tap walkthrough remaining, like task 024's pattern.

## Acceptance criteria

- [ ] An agent question with options renders as interactive blocks in
      the thread.
- [ ] A simulated `block_actions` envelope resolves the question: the
      choice reaches the session as its answer, and the message updates
      to show the selection.
- [ ] A live tap by the operator completes a real question round-trip.
- [ ] Questions without structure (plain input-required) behave exactly
      as today.

## References

- Block elements: https://docs.slack.dev/reference/block-kit/block-elements.md
- Related: task 024 (approvals) is the high-stakes cousin of this
  surface and stays parked; this task must not quietly implement
  approvals semantics.

## Out of scope

Approvals (024). Modals. Anything that lets a tap edit the system prompt.
