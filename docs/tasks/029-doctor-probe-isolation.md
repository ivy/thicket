---
id: "029"
title: thicket doctor must survive a failing probe
status: todo
component: apps/cli
language: typescript
depends_on: ["010"]
blocks: []
parallel_safe: true
---

# thicket doctor must survive a failing probe

## Context

Observed twice during live checks for 019 and 020: on a host without the
`tailscale` binary, `thicket doctor` dies with `spawn tailscale ENOENT`
before reaching any later check. `runDoctor` awaits each probe bare, so one
throwing probe aborts the whole run — the bridge-health check added in 019
never executed, and the operator got a stack trace instead of a report.

A doctor that crashes on the first unhealthy subsystem is useless for
exactly the situations it exists for.

## Scope

- A probe that throws becomes a failed check with the error in its message,
  and the run continues to the remaining checks.
- A missing external binary (`tailscale`, `loginctl`) reads as "cannot
  check" with a hint, not as a crash. On a development host this is the
  normal case, not an error worth a stack trace.
- Exit code stays non-zero when any check failed, including probe failures.

## Acceptance criteria

- [ ] With a probe that throws, `runDoctor` still returns results for every
      other check.
- [ ] A missing tailscale binary produces a readable FAIL line for the
      tailnet check and the run continues.
- [ ] Observed on the dev rig: `thicket doctor` reports the bridge health
      check even though tailscale is absent.

## Out of scope

New checks. This is about the harness around the existing ones.
