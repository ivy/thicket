---
id: "041"
title: Release pipeline — a tag becomes attested artifacts
status: todo
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
[046](046-ci-gate-and-workflow-lint.md); this task adds the release half
to a repo that already has CI, and holds it to the same bar.

Depends on [039](039-open-source-readiness.md) because public releases are
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
- [ ] A red gate produces no release.
- [ ] `mise install github:ivy/thicket@<tag>` on darwin-arm64 and linux
      verifies the attestation (observed in mise's output) and puts all four
      executables on PATH.
- [ ] The release workflow passes the `workflows` lint job and grants
      write permissions only where the release is created.
- [ ] AGENTS.md describes the release flow.

## Out of scope

`thicket install` and the unit files ([042](042-cli-install.md)). Publishing
to any registry beyond GitHub releases. Changelog automation.
