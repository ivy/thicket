---
id: "042"
title: thicket install — the last mile after mise
status: blocked
component: apps/cli
language: typescript
depends_on: ["041"]
blocks: []
parallel_safe: true
---

# thicket install

## Context

The per-account deploy recipe is three steps:

```sh
mise use -g github:ivy/thicket@1.2.3
thicket install
systemctl --user restart thicket-netd thicket-agentd
```

With artifacts arriving via mise there is no repo checkout on the host, so
the unit files must arrive inside the binary. Steps 5–6 of
[deploy/README.md](../../deploy/README.md) — install binaries, copy units —
collapse into this command. The units are already parameter-free
(`deploy/check.sh` enforces no hardcoded usernames), so embedding does not
fork them per account.

## Scope

- Embed the systemd units and launchd plists in the compiled CLI (Bun's
  compiled executables can carry assets; they are short enough to inline as
  source if not).
- `thicket install`: detect the platform; write the units or plists;
  `daemon-reload` / `launchctl bootstrap`; enable what should be enabled;
  restart what is already running. Idempotent — a re-run with nothing
  changed does nothing and says so. Refuses to run as root. `--dry-run`
  prints the plan.
- Role awareness: an agent account installs `thicket-netd.service` and
  `thicket-agentd.service`; the bridge account installs netd plus
  `thicket-bridge.service` and no agentd. Whether the role comes from the rendered config present in the
  account or from a flag is an implementation decision — but a wrong guess
  must fail loudly, never install the wrong role.
- Post-install, run the in-account doctor probes that apply (lingering,
  socket present) and print the result.
- Rewrite deploy/README around the new recipe. Root-only steps (useradd,
  lingering) remain a runbook that precedes it.

## Acceptance criteria

- [ ] A fresh account with mise and a pinned thicket goes from nothing to a
      listening agentd socket via the three-step recipe.
- [ ] Re-running `thicket install` is a stated no-op.
- [ ] The bridge account installs the bridge role, not agentd's.
- [ ] The macOS path works via launchd, verified on the Mac.
- [ ] deploy/README describes the mise-based flow; the checkout/symlink
      steps are gone.

## Out of scope

The root-owned account setup (useradd, linger) — operator runbook, by
design. Fleet-wide orchestration of updates across accounts — a script or a
future `thicket fleet update`, once updating by hand has been annoying for
longer than an evening.

## Blocked (2026-08-29)

**What is needed: the repository made public**, the same operator step
[041](041-release-pipeline.md) waits on.

The first acceptance criterion is the whole point of the command — a fresh
account going from nothing to a listening agentd socket through
`mise use -g github:ivy/thicket@X && thicket install`. That needs a published
release whose CLI contains `thicket install`, and 041 cannot publish one:
`actions/attest-build-provenance` refuses on a user-owned private repository,
so the release job never runs. Building the command against a release that
cannot exist would leave its central claim unverifiable.

### What is not blocked

Being honest about the size of this: four of the five criteria do not need a
release. The launchd path is verifiable on the Mac today, idempotency and role
detection are local behaviour, and the deploy/README rewrite is prose. They
are not being built ahead because the loop does not start a task whose
dependency is blocked (PROMPT.md §2), not because they are impossible — if the
flip is going to be a while, this task is worth splitting rather than waiting.

### To unblock

1. Flip the repository public (039's `## Ready to flip`), which unblocks 041.
2. Land 041's remaining criterion — a tag that publishes attested archives.
3. Start this task; the recipe it documents is then testable end to end.
