# Roadmap

Where the fleet is going, arc by arc. [vision.md](vision.md) says what thicket is;
the [issue tracker](https://github.com/ivy/thicket/issues) says what is being built
this week. This file is the middle: the order the arcs land in, why that order, and
what must be true before the next one starts.

## Rules

- **An arc is entered by shipping its first automation end to end**, never by building
  its platform ahead of one. The second use case earns a generalization; the first
  makes do.
- **Oversight precedes autonomy.** An agent takes on unattended work only after its
  activity is visible from the human surface and its irreversible acts are gateable
  ([#10](https://github.com/ivy/thicket/issues/10)).
- **The budget is human hours.** Agent time spent on the foundation is the system
  working; operator time spent on it is the signal to stop generalizing and ship the
  next automation instead.

## Arc 1 — a surface I can trust

Built, not finished. Status fidelity, message splitting and dialects, the
question UI, reactions, routines all exist; what remains is the tail of bugs that
each produce a moment of doubt — a status line that goes blank on a long step
([#93](https://github.com/ivy/thicket/issues/93)), a reconnect whose orphaned
watchdog kills the healthy connection ([#94](https://github.com/ivy/thicket/issues/94)),
an answered question re-asked on session recycle
([#105](https://github.com/ivy/thicket/issues/105)), background work that is reaped,
invisible, or un-stoppable from the surface
([#106](https://github.com/ivy/thicket/issues/106)–[#108](https://github.com/ivy/thicket/issues/108)).
Not polish for its own sake — the Slack surface is the oversight channel every later
arc depends on: the place autonomous work is watched, questioned, and stopped.

Done when: driving the fleet from a phone for a full day produces no moment of "what is
it doing?" — status, questions, and long answers all render correctly, and a routine
fires on schedule into a live socket.

## Arc 2 — off the laptop (now)

The fleet is on the server: four agents, both bridges, `netd` everywhere, deployed
from attested releases by the operator's Ansible per
[deploy/README.md](../deploy/README.md). The founding use case is what remains:
Claude Code on the laptop delegates to a server agent that edits the operator's
playbooks and applies them — propose-and-show-diff first, auto-apply only after
approvals exist. Proposals already flow and the privileged agent already applies
host changes; what blocks the rest is approvals
([#10](https://github.com/ivy/thicket/issues/10)), privilege inside a deployed
agent's own unit ([#91](https://github.com/ivy/thicket/issues/91)), and the
propose → review → approve → deploy → verify → rollback composition
([#103](https://github.com/ivy/thicket/issues/103)).

- Two iteration loops, kept separate. The **platform loop** — thicket itself — ships
  as attested release artifacts: a tag push runs the gate and publishes per-platform
  executables ([#15](https://github.com/ivy/thicket/issues/15)), and an account updates by
  repinning (`mise use -g github:ivy/thicket@…`) and re-running
  [`thicket install`](https://github.com/ivy/thicket/issues/16). The repo goes public
  first so no account needs a token, and the runtime moves to Bun so no account needs
  Node or a checkout — both landed. The **agent loop** — skills, `CLAUDE.md`, tools
  inside the account — is where daily iteration lives and needs no redeploy at all.
- [#11](https://github.com/ivy/thicket/issues/11) leaves the icebox: the agent loop must
  be versioned and rendered, not hand-grown per host.
- Channel→workspace binding: a project
  channel names a workspace, and the channel's agent runs its sessions with that
  working directory, so the repo's own `CLAUDE.md` and skills are the channel's
  memory.

Done when: a homestead playbook change is requested from Slack on a phone, reviewed as
a diff, and applied on the server — with the laptop closed the whole time.

## Arc 3 — reactivity

Events join people and the clock as triggers. `thicket send` shipped ahead of this
arc because the first event consumer needed it — a git post-receive on the
operator's host already wakes an agent through it.
[#12](https://github.com/ivy/thicket/issues/12) leaves the icebox as the minimum viable
ingress — with `send`, a webhook receiver is a shell script — followed by a
real GitHub-events bridge when a second consumer asks for one.
[#9](https://github.com/ivy/thicket/issues/9) and
[#10](https://github.com/ivy/thicket/issues/10) come out with it; approvals land before
any pipeline is allowed to end in a merge.

First shipped automation: the Renovate pipeline. An ingest-class agent reviews the bump
and emits a verdict artifact; deterministic gates — checksums, CI, provenance — sit
between verdict and merge; a separate identity merges. Grove-class blast radius, high
frequency, and it exercises ingress, delegation, and the untrusted-ingest rule in one
shot.

Done when: a dependency bump reaches production with no human involvement beyond an
approval tap — and a malicious changelog aimed at the reviewing agent has nowhere to
go.

## Arc 4 — life administration

Hearth-class work: transaction forensics against the inbox, calendar-driven
subscription management, the standing errands of one person's life. Mostly routines
plus per-account capability — mail, calendar, bank data, vendor portals — and little of
it is thicket platform work at all. Deliberately last: the data is the most sensitive
and the integrations the ugliest, so it enters only on a proven oversight surface with
approvals in the muscle memory.

Done when: a week of travel reschedules the coffee delivery and skips the meal box
without me touching either.
