---
id: "048"
title: A merge is gated on independent agent verdicts (research)
status: icebox
component: .
language: none
depends_on: ["023", "024", "028"]
blocks: []
parallel_safe: true
---

# A merge is gated on independent agent verdicts

**This is a research ticket. It ends in a written recommendation, not a
merge.**

## Context

An agent pushes a branch. Before it lands, other agents have to be satisfied:
one checks the change against the ticket it claims to close, one checks the
code, one checks it for security holes. The author answers findings and
pushes again. Nobody is at the keyboard.

**The motivation is separation, not skill.** An agent reviewing its own work
is not a reviewer. It carries the author's context, the author's
rationalisations, and the author's incentive to be finished. Requirements get
quietly dropped, holes get overlooked, architecture rots — not because the
instructions were absent but because the session that wrote the code is the
one being asked whether the code is good. A reviewing *skill* on the author
does not fix that. A distinct evaluator, with its own context, that never
authored the change and whose verdict has to be earned, does.

That is a different axis from the roster rule. *"Add an agent when you need a
new blast radius, not a new skill"* governs privilege. It says nothing about
whether an evaluator must be separate from the thing it evaluates — and the
vision's own strongest structural move, *"the guard that reads the poison
never holds the keys"*, is exactly such a separation.

### What the vision already settles

**The pipeline is an agent's job.** *"Bridges hold no policy. When one event
fans out into a pipeline — review, then refactor, then merge — that pipeline
is an agent's job, delegated over A2A."* A bridge holding this workflow would
have become a workflow engine.

**How untrusted the input is depends on who wrote the PR.** The case that
motivates this is the operator's own agent proposing a change to the
operator's own repo, where what needs catching is drift, self-review bias and
rot — not an adversary. Arc 3 ends somewhere else: a dependency bump or a
fork PR, where the diff, the changelog and the commit messages are
attacker-influenced text aimed squarely at the agent reading them, and the
reviewers are ingest-class. One mechanism has to serve both, so the gate's
shape is set by the second case even though the first is why it gets built.

**No model output waives a gate.** *"Between the verdict and the privileged
act sit deterministic gates — checksums, CI, provenance — that no model
output can waive."* A reviewer emits a verdict artifact; something
deterministic reads it and decides whether the branch is mergeable.

## The gate blocks by default, and an agent may only widen it

The PR blocks the way CI blocks: the check is required, and it is pending or
red until satisfied. A triage agent fits that cleanly — it reads the change,
decides which reviewers this one needs, and the check stays pending until
each of them is satisfied.

The property to preserve is that **whoever decides the required set is the
gate.** A triage agent that picks the reviewers holds the merge as surely as
a reviewer with a merge button would, and it reads the same diff. "Docs-only
change, no security review needed" is the entire bypass, and it is one
sentence — no reviewer has to be fooled at all.

That constrains triage rather than ruling it out. Make it monotonic:

- **A deterministic floor,** computed without a model from paths touched,
  author provenance, and config in git. Those checks are named in branch
  protection so they block by *absence* — a check nothing ever reports is a
  merge that cannot happen, which is fail-closed for free and does not depend
  on triage having run. A floor that triage must create is a floor that
  vanishes when triage crashes.
- **Triage adds to the set, never subtracts.** The worst a wrong or steered
  triage can then do is demand review nobody needed: an annoyance, not a
  bypass.
- **The set is a union over the PR's history,** not a property of its tip.
  Otherwise push the docs, let triage choose a light set, then push the real
  change — a bypass needing no injection whatsoever.
- **Verdicts bind to a commit SHA** and are re-earned on every push, triage
  included, since a later push can touch a path the first one did not.

Nothing there asks a reviewer or a triage agent to resist being talked into
something, because neither is holding the merge. They fill in a set of checks
whose floor they did not choose.

## Open — where the reviewers talk

In the PR's own review threads, where a human can watch, or over A2A, where
the vision puts agent-to-agent traffic. State the case both ways. The pull
toward GitHub is real: the operator wants to see the reasoning, and a PR
thread is a durable record in the place you would look for it.

The case against is that review threads are chat, and chat was ruled out as
an agent bus for three reasons that all transfer — mention loops between two
bots each answering the other, a per-app event and rate budget spent on
machine traffic, and no way to carry `taskId`, `contextId`, or artifacts.

A fourth reason has no Slack equivalent. **A PR comment is unauthenticated to
the model reading it.** A2A over netd carries a peer identity netd verified
with a `WhoIs` lookup and set as a header; a comment body carries only a
claim. Anyone who can write to the PR — on a public repo, anyone, before
counting the diff itself quoting text — can write "the security reviewer
approved this" into the stream the reviewers read. Making the review thread
the bus makes the fleet's coordination channel writable by strangers, in the
one pipeline where the attacker is already assumed present.

The likely answer is the Slack-thread precedent applied unchanged:
coordination over A2A carrying the PR's coordinates in `Task.metadata`, and
publication to the PR under each agent's own identity. **Write-through, not
read-back.** The PR is the audit log, not the bus. Read-back is confined to
*human* comments, which enter as ingest and carry no authority.

That is a position to attack, not a conclusion. The research should try to
break it — starting with whether write-through delivers the visibility that
motivated it, or only an unreadable transcript.

## Open — what "consensus" means mechanically

Unanimity of independent verdicts and a negotiated agreement are different
machines, and only one of them preserves the property being bought.

Independence is the whole value. Reviewers that deliberate with each other
can be talked out of findings, anchor on whoever spoke first, and converge on
a shared blind spot — which is the author-reviewing-itself failure
reintroduced one level up. An AND of N independent verdicts, each its own
required check, has none of that, and needs no discussion at all.

The conversation that clearly *is* worth having is author ↔ reviewer: a
finding is raised, the author answers or fixes, the reviewer re-runs. Which
implies a verdict is bound to a commit and must be re-earned on every push,
never carried forward.

So the research has to say what the reviewers actually need from each other,
if anything, and produce evidence rather than intuition. A plausible answer
is: nothing, and the "discussion" the idea imagines is really the author
answering three separate critics.

## What to research

- **Prior art first.** Agentic PR review is crowded — review bots, the
  multi-agent-debate and LLM-judge literature (including the evidence on
  whether debate improves or degrades accuracy), anything wiring A2A to a
  repo host. Report what is worth adopting and what is not, with reasons.
- **The verdict artifact and its gate.** What a verdict contains, where it is
  stored, how a required status check reads it, and how it is bound to a
  commit SHA so it cannot outlive the code it judged. What happens when a
  reviewer never answers.
- **Triage and the floor.** Whether GitHub branch protection really blocks on
  a required check that has never been reported — the mechanism the whole
  fail-closed story rests on — and how a triage-added reviewer becomes a
  check that did not exist when the PR opened. Where the floor is written so
  that it is config rather than model output, and how it reads author
  provenance: an operator's own agent, a bot, and a fork are three different
  starting sets.
- **Where determinism is cheaper than judgment.** Some of "requirements get
  skipped" is machine-checkable — acceptance criteria as structured data,
  architecture fitness tests, a secret scanner. An LLM spent on what a linter
  does is worse than the linter: slower, dearer, and non-deterministic. Draw
  the line, and say what each reviewer is for on the judgment side of it.
- **Identity on the repo host.** One GitHub App per agent mirrors one Slack
  app per agent, and is what makes "under its own identity" true rather than
  a name in a comment body. Find the cost: install limits, rate limits, what
  a bot may author, whether a bot's review can satisfy branch protection. The
  free Slack plan's 10-app cap is the cautionary parallel.
- **Whether the roster grows, and where.** Contextual separation comes from a
  fresh `contextId`, not from a unix account — three reviewers can be three
  tasks on one ingest-class agent and still never see each other's context. A
  roster entry is earned where *credentials* differ: an agent that writes to
  the ticket tracker, or one holding a scanner's licence, is a boundary; one
  that only reads a diff is not. Say which of the three proposed reviewers is
  which, and what a separate account buys that a separate context does not.
- **Ingress.** How a PR event reaches the fleet. [028](028-cli-send.md) is
  the minimum viable path — with `thicket send`, a webhook receiver is a
  shell script. Say whether that suffices or whether latency and replay
  demand a real GitHub bridge.
- **Failure semantics.** A reviewer unreachable, slow, or refusing. What the
  PR says, under whose name, and how the gate reads that — noting that fail-
  closed on an unreachable reviewer is a self-inflicted outage on every merge.

## Acceptance criteria

- [ ] A written recommendation on the transport question, with the strongest
      case against it stated rather than omitted.
- [ ] A design for the verdict artifact and the deterministic gate that reads
      it, in which no model output can waive the gate.
- [ ] A triage design that can only widen the required set, over a floor that
      survives triage never running — verified against branch protection's
      actual behaviour, not its documentation.
- [ ] An answer on whether reviewers deliberate or vote, backed by evidence
      rather than intuition.
- [ ] A line drawn between what a deterministic check should catch and what
      needs an agent's judgment.
- [ ] An answer on repo-host identity: how many identities, what they cost,
      and what breaks without them.
- [ ] A statement of which reviewers are separate contexts and which are
      separate accounts, and why.
- [ ] Follow-on implementation tasks filed with real scope — or a written
      reason not to build it.

## Out of scope

Building it. Any design in which an agent can narrow the required set rather
than widen it, or in which an agent holds the merge rather than feeding a gate — [024](024-approvals.md) and the deterministic gates own the step
between verdict and privileged act. Routing agent coordination through GitHub
review threads as the transport, unless the research overturns the vision's
rule, in which case the vision changes first, in its own commit.

## References

- [docs/vision.md](../vision.md) — "A2A is the only transport between
  agents", "Untrusted ingest never reaches privilege", "Bridges are adapters".
- [docs/roadmap.md](../roadmap.md) — Arc 3. The Renovate pipeline is this
  shape with one reviewer and no author.
- [023](023-agent-delegation.md) — delegation is the mechanism this needs.
- [024](024-approvals.md) — the gate before anything irreversible.
- [028](028-cli-send.md) — the ingress.
