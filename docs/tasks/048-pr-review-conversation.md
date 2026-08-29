---
id: "048"
title: Agents review a pull request together (research)
status: icebox
component: .
language: none
depends_on: ["023", "024", "028"]
blocks: []
parallel_safe: true
---

# Agents review a pull request together

**This is a research ticket. It ends in a written recommendation, not a
merge.**

## Context

An agent pushes a branch and opens a pull request. Other agents review it:
one reads the ticket the change claims to close and says whether it does;
one reads the diff and says whether it is any good. The author answers,
revises, pushes again. Nobody is at the keyboard.

Two things about that loop are already settled, and one is not.

**Settled — the pipeline is an agent's job.** *"Bridges hold no policy. When
one event fans out into a pipeline — review, then refactor, then merge —
that pipeline is an agent's job, delegated over A2A, because judgment lives
where skills and `CLAUDE.md` do."* A bridge that held this workflow would
have become a workflow engine.

**Settled — every input here is untrusted ingest.** Diffs, commit messages,
ticket bodies, and PR comments are attacker-influenced text aimed squarely
at the agent reading them. The reviewers are ingest-class, their output is a
verdict artifact, and deterministic gates sit between verdict and merge. The
vision already names this exact pipeline as the case that proves the rule.

**Open — where the reviewers talk to each other.** In the PR's own review
threads, where a human can watch, or over A2A, where the vision puts
agent-to-agent traffic.

## The open question

State the case both ways before answering it. The pull for GitHub is real:
the operator wants to see the reasoning, and a PR thread is a durable,
already-familiar record that outlives any process.

The case against is that GitHub review threads are chat, and the vision
already ruled chat out as an agent bus for three reasons that all transfer —
mention loops between two bots that each answer the other, a per-app event
and rate budget spent on machine traffic, and no way to carry `taskId`,
`contextId`, or artifacts.

There is a fourth reason that Slack does not have. **A PR comment is
unauthenticated to the model reading it.** A2A over netd carries a peer
identity that netd verified with a `WhoIs` lookup and set as a header;
a comment body carries only a claim. Anyone who can write to the PR — and on
a public repo that is anyone, before counting the diff itself quoting text —
can write "the reviewer approved this" into the same stream the reviewers
read. Turning the review thread into the bus makes the fleet's coordination
channel writable by strangers.

So the likely answer is the Slack-thread precedent, applied unchanged:
coordination over A2A carrying the PR's coordinates in `Task.metadata`, and
publication to the PR under each agent's own identity. **Write-through, not
read-back.** The PR is the audit log, not the bus; the human sees one
conversation and the coordination never touches GitHub. Read-back is
confined to *human* comments, which enter as ingest and carry no authority.

That is a position to attack, not a conclusion. The research should try to
break it — in particular on whether write-through actually delivers the
visibility that motivated the idea, or only an unreadable transcript.

## What to research

- **Prior art first.** Agentic PR review is crowded — review bots, the
  multi-agent-debate literature, anything wiring A2A to a repo host. Report
  what is worth adopting and what is not, with reasons.
- **Identity on the repo host.** One GitHub App per agent mirrors one Slack
  app per agent, and is what makes "under its own identity" true rather than
  a name in a comment body. Find the cost: install limits, rate limits, what
  a bot may author, and whether a per-agent identity is purchasable at this
  fleet's size. The free Slack plan's 10-app cap is the cautionary parallel.
- **Ingress.** How a PR event reaches the fleet. [028](028-cli-send.md) is
  the minimum viable path — with `thicket send`, a webhook receiver is a
  shell script. Say whether that is enough or whether the latency and replay
  story demands a real GitHub bridge.
- **Whether the roster grows at all.** "Product manager" and "code reviewer"
  are skills, not blast radii, and the roster grows only for a new blast
  radius. Two agents are justified only if one holds a credential the other
  must not — an agent that *writes* to the ticket tracker is the candidate;
  one that only reads a diff is not. Say plainly which proposed reviewer is
  a trust boundary and which is a persona.
- **Whether the debate earns its cost.** Two agents arguing versus one
  ingest-class agent with two skills and two verdicts. What terminates the
  discussion, who declares it converged, and what bounds turns and tokens
  when they do not.
- **Failure semantics.** A reviewer that is unreachable, slow, or refuses.
  What the PR says, under whose name, and whether a partial review is worth
  publishing.

## Acceptance criteria

- [ ] A written recommendation on the transport question, with the strongest
      case against it stated rather than omitted.
- [ ] An answer on repo-host identity: how many identities, what they cost,
      and what breaks without them.
- [ ] A statement of which reviewer roles are blast radii and which are
      personas, and whether the roster grows.
- [ ] Termination and cost bounds proposed for the review conversation.
- [ ] Follow-on implementation tasks filed with real scope — or a written
      reason not to build it.

## Out of scope

Building it. Anything that merges on an agent's verdict: the deterministic
gates and [024](024-approvals.md) own the step between verdict and merge.
Routing agent coordination through GitHub review threads as the transport,
unless the research overturns the vision's rule — in which case the vision
changes first, in its own commit.

## References

- [docs/vision.md](../vision.md) — "A2A is the only transport between
  agents", "Untrusted ingest never reaches privilege", "Bridges are adapters".
- [docs/roadmap.md](../roadmap.md) — Arc 3. The Renovate pipeline is this
  shape with one fewer reviewer.
- [023](023-agent-delegation.md) — delegation is the mechanism this needs.
- [024](024-approvals.md) — the gate before anything irreversible.
- [028](028-cli-send.md) — the ingress.
