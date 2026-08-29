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
systemctl --user restart thicket-netd thicket-agentd.socket
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
- Role awareness: an agent account installs netd + the agentd socket/service
  pair; the bridge account installs netd + `thicket-bridge.service` and no
  agentd. Whether the role comes from the rendered config present in the
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

## Blocked

Recorded 2026-08-28. Blocked behind [041](041-release-pipeline.md):
`thicket install` ships inside the compiled CLI that 041 publishes, and
its first criterion is a fresh account pulling a pinned release through
mise. The systemd path also needs the Linux host on 013's list; the
launchd path can be verified on the Mac once a release exists. Unblocks
when 041 lands.
