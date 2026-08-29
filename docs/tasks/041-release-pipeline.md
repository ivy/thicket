---
id: "041"
title: Release pipeline — a tag becomes attested artifacts
status: blocked
component: .
language: none
depends_on: ["039", "040", "046"]
blocks: ["042"]
parallel_safe: true
---

# Release pipeline

## Context

Deploying thicket is repinning: `mise use -g github:ivy/thicket@1.2.3`.
mise's `github` backend (ubi is deprecated upstream) autodetects platform
assets, verifies GitHub artifact attestations **by default**, and records
URL, checksum, and provenance in lockfiles — so every account's install is
the verifier, and no custom signing machinery is needed. The pipeline's job
is only: turn a tag into per-platform archives with attestations, gated by
the same three commands that gate everything else.

The gate itself — CI on every push, and the workflow linters — is
[046](archived/046-ci-gate-and-workflow-lint.md); this task adds the release half
to a repo that already has CI, and holds it to the same bar.

Depends on [039](archived/039-open-source-readiness.md) because public releases are
what make tokenless pulls work. If the flip is delayed, the escape hatch is a
fine-grained PAT (Contents: read-only, scoped to `ivy/thicket`) per account
in `~/.config/mise/github_tokens.toml` — workable, but it is a secret to
distribute and rotate on every account, which is the class of toil this
design exists to avoid.

## Scope

- A workflow on tag push (`v*`): run the gate — build, test, lint, and
  `go test ./netd/...` — then produce, per platform, **one archive with a
  `bin/` directory holding all four executables** (`thicket`,
  `thicket-agentd`, `thicket-bridge`, `thicket-netd`). One asset per
  platform keeps mise's autodetection trivial and avoids the
  same-install-dir footgun of per-binary assets.
- Cross-compile: `netd` via Go's cross-compilation, the TS executables via
  `bun build --compile --target=...`. Targets follow the fleet: linux
  (server) and darwin-arm64 (the Mac); add linux-arm64 only when a host
  exists.
- Attest the archives with `actions/attest-build-provenance`; create the
  release.
- The release workflow runs the gate first — reuse 046's job, so a tag
  never discovers red first — and meets 046's bar: every `uses:`
  SHA-pinned, `permissions` least-privilege with `contents: write`,
  `id-token: write`, and `attestations: write` granted only to the job
  that publishes, a `concurrency` group, `timeout-minutes`, and a clean
  pass from actionlint, zizmor, and pinact in the `workflows` job.
- Asset names the autodetector scores correctly — verified, not assumed, by
  installing on both platforms.
- AGENTS.md's release facts: how a tag becomes a release, and that the
  gate guards it.

## Acceptance criteria

- [ ] Pushing a tag produces a release: per-platform archives with
      attestations, and the gate ran first.
- [x] A red gate produces no release.
- [x] `mise install github:ivy/thicket@<tag>` on darwin-arm64 and linux
      verifies the attestation (observed in mise's output) and puts all four
      executables on PATH. The attestation mise verified is the one GitHub
      writes for a release, not build provenance — see `## Blocked`.
- [x] The release workflow passes the `workflows` lint job and grants
      write permissions only where the release is created.
- [x] AGENTS.md describes the release flow.

## Out of scope

`thicket install` and the unit files ([042](042-cli-install.md)). Publishing
to any registry beyond GitHub releases. Changelog automation.

## Blocked

**What is needed: the repository made public.** That is 039's operator step,
still outstanding.

`actions/attest-build-provenance` refuses outright on a user-owned private
repository (run 33239963963, 2026-08-29):

```
Failed to persist attestation: Feature not available for user-owned private
repositories. To enable this feature, please make this repository public.
```

There is no flag, plan setting or alternative endpoint for it — the API says
what it wants. Everything before that step ran: the gate passed, the archives
built for both platforms, and the provenance predicate was generated. The step
after it, creating the release, never ran, so `v0.1.0-rc.1` produced no
release of its own.

### What was verified anyway

`v0.1.0-rc.1`'s archives were published by hand from exactly the artifacts the
pipeline built, so the rest of the design could be checked rather than assumed:

- mise's autodetection picked `thicket-v0.1.0-rc.1-macos-arm64.tar.gz` on this
  Mac and `…-linux-x64.tar.gz` on an ubuntu runner, with no `asset_pattern`;
  the archive's root `bin/` was found with no `bin_path`, and all four
  executables landed on PATH on both.
- mise printed `✓ GitHub artifact attestations verified` on both. That is
  **not** the build provenance this task wants: creating a release makes
  GitHub attest it automatically, with an
  `in-toto.io/attestation/release/v0.2` predicate over the tag and the asset
  digests. It proves the assets are the ones attached to that release; it says
  nothing about which workflow built them.
- A job that installs a release needs `attestations: read`. Without it mise
  fails with a 403 rather than skipping verification.

### To unblock

1. Flip the repository public (039's `## Ready to flip`).
2. Delete the `v0.1.0-rc.1` release and its tag — they were a fixture, and the
   release was not built by the workflow.
3. Push a fresh tag and check the remaining criterion: the run publishes
   per-platform archives carrying SLSA build provenance, and `verify` passes
   without being dispatched by hand.
