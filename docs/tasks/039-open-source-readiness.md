---
id: "039"
title: Open the repo — ISC license, README, and a clean history
status: in-progress
component: .
language: none
depends_on: []
blocks: ["041"]
parallel_safe: true
---

# Open the repo

## Context

The repo lives at `ivy/thicket` on GitHub, private, with a small history.
The decision is to build in the open: public releases are what let every
agent account pull artifacts with no per-account token
([041](041-release-pipeline.md)), and the pre-publication scrub costs minutes
now where in six months it would be an audit. The committed `agents.yaml` is
already an example roster; the real one lives in `~/.config/thicket/`, and
token files have lived outside the repo from the start.

## Scope

- `LICENSE` at the root: ISC, `Copyright (c) 2026 Ivy Evans`.
- A README pass for a public reader: what thicket is, links to
  [vision](../vision.md) and [roadmap](../roadmap.md), and one sentence
  setting expectations — one operator's fleet, built in the open; issues
  welcome, the roadmap is the operator's.
- A history-wide secrets scan (gitleaks or trufflehog, over every commit).
  Rewrite history only if something is found; nothing should be.
- Skim the leak-prone docs — `docs/tasks/`, `LIVE-TESTING.md`,
  `docs/runbook.md` — for identifiers that should not publish: Slack team and
  channel IDs, tailnet hostnames, personal paths.
- Operator handoff: flipping the repo public is the operator's act. The task
  ends with a ready-to-flip note recording what was checked and with which
  tools.

## Acceptance criteria

- [ ] `LICENSE` (ISC) exists; README links vision and roadmap and states the
      built-in-the-open expectation.
- [ ] The full-history secrets scan ran clean; tool and invocation recorded
      here.
- [ ] The docs skim found nothing unpublishable, or what it found was fixed.
- [ ] The public flip is documented as the operator step — not performed.

## Out of scope

The release workflow ([041](041-release-pipeline.md)). Renaming the local
checkout directory — cosmetic, operator's call.
