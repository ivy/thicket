---
id: "027"
title: Provision the agent's workspace — CLAUDE.md, skills, MCP config
status: icebox
component: apps/cli
language: typescript
depends_on: ["010"]
blocks: []
parallel_safe: true
---

# Provision the agent's workspace

## Context

The vision is explicit about where an agent's specialization comes from:

> Specialization within a boundary comes from skills, `CLAUDE.md`, and the
> tools installed in that account.

And equally explicit about how everything else gets there:

> Slack app manifests, per-account configuration, and tailnet identities are
> rendered from `agents.yaml` by the provisioning CLI. […] If something must
> be hand-edited after generation, that is a bug in the generator.

Those two statements do not currently meet. `provision` renders Slack
manifests, agentd config, netd config — and then the thing that actually
determines what the agent *is* has to be written by hand, on each host, as
each unix user, with no version control and no way to tell whether two agents
are running the same instructions.

`agents.yaml` already declares `skills[]` per agent. Today those are used only
to generate the AgentCard and the Slack description. The agent's own Claude
Code installation knows nothing about them.

## Scope

- Render an agent's workspace from the repo: `CLAUDE.md`, `.claude/skills/`,
  MCP server configuration, and whatever else the harness reads from the
  account.
- Shared content plus per-agent content, so four agents can share a house
  style without four copies of it drifting apart.
- Make `skills[]` in the roster mean something to the agent, not just to its
  card — or decide deliberately that card skills and installed skills are
  different things, and say why.
- Drift detection, matching how the Slack manifest already works: the CLI
  should be able to say "this account's workspace no longer matches the repo".
- Delivery to accounts on other hosts. `provision` runs as the operator; the
  files land in another unix account, possibly on another machine. That is the
  hard part and the reason this is not trivial.

## Open questions

- **How files cross.** Over the tailnet as a bridge/agentd route, out of band
  with git or rsync, or pulled by the agent itself on a schedule. Pull is
  attractive: it keeps the "agentd never touches the network" line intact and
  needs no push credentials.
- **Whether the agent may edit its own workspace.** An agent that can rewrite
  its own `CLAUDE.md` is either wonderfully self-improving or unbounded,
  depending on the account.
- Restart semantics: a changed `CLAUDE.md` matters only on the next session.

## Acceptance criteria

- [ ] An agent's instructions and skills come from the repo, reproducibly.
- [ ] Two agents can share content without duplicating it.
- [ ] Drift from the repo is detectable.
- [ ] Nothing about an agent's identity requires hand-editing a file on a
      remote host.

## Out of scope

Installing binaries or managing the account's toolchain — that is deployment
(task 012), not agent identity.
