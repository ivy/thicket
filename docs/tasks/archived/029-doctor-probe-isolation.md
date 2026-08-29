---
id: "029"
title: thicket doctor must survive a failing probe
status: done
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

- [x] With a probe that throws, `runDoctor` still returns results for every
      other check.
- [x] A missing tailscale binary produces a readable FAIL line for the
      tailnet check and the run continues.
- [x] Observed on the dev rig: `thicket doctor` reports the bridge health
      check even though tailscale is absent.

## What verification established (2026-08-27)

Every probe call now goes through an `attempt` wrapper: a throw becomes a
failed check whose message starts "cannot check", `spawn X ENOENT` is
prettified to "\`X\` is not installed on this host", and the run
continues. `realProbes.lingeringEnabled` no longer swallows errors into a
false "no lingering" — cannot-check is the honest answer on a host
without loginctl. Live on the rig (no tailscale, no loginctl):

```
FAIL [tailnet]: cannot check: `tailscale` is not installed on this host
FAIL [lingering] hearth: cannot check: `loginctl` is not installed on this host
ok   [bridge] hearth: Socket Mode connection up
ok   [workspace]: workspace app usage 0/10
```

exit 1, full report. The same run surfaced that the card check has never
been wired to a roster (`realProbes()` called bare in bin.ts) — filed as
task 033 rather than fixed here.

## Out of scope

New checks. This is about the harness around the existing ones.
