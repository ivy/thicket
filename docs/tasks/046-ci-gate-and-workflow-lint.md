---
id: "046"
title: CI gate on every push, and the workflows themselves are linted
status: in-progress
component: .
language: none
depends_on: []
blocks: ["040", "041"]
parallel_safe: true
---

# CI gate on every push, and the workflows themselves are linted

## Context

The repo has no CI: the three commands from the root are the only gate,
run by whoever is landing the change. 041 was going to bring the first
workflow along with the release pipeline, but the gate needs nothing the
release needs — not Bun, not artifacts — and a toolchain-wide port (040)
is exactly the change that should land under a gate rather than before
one. So the gate comes first, on its own.

The operator's bar (2026-08-28): follow GitHub Actions best practice, use
a proper Actions linter and check against it, and have CI lint the
workflows themselves whenever they change. All three tools below install
through mise (`aqua:` backend), which keeps "toolchain pinned in
`mise.toml`" true for them too:

| Tool | What it catches | mise |
|---|---|---|
| [actionlint](https://github.com/rhysd/actionlint) | workflow syntax and semantics, expression types, unknown inputs, `shellcheck` over every `run:` step | `actionlint` (1.7.12 today) |
| [zizmor](https://github.com/zizmorcore/zizmor) | security: unpinned `uses:`, template injection in `run:`, excessive permissions, dangerous triggers, artifact credential leaks | `zizmor` (1.29.0) |
| [pinact](https://github.com/suzuki-shunsuke/pinact) | pins every `uses:` to a full commit SHA with a version comment, and `--check` fails on any that is not | `pinact` (4.1.1) |

## Scope

- `.github/workflows/ci.yml`, on `push` to `main` and on `pull_request`,
  two jobs:
  - **gate** — checkout; `jdx/mise-action` installs the toolchain from
    `mise.toml` (no separate setup-node/setup-go); `pnpm install
    --frozen-lockfile`; then exactly the root contract — `pnpm build`,
    `pnpm test`, `pnpm lint` — plus `pnpm build:netd && go test
    ./netd/...`. The pnpm store is cached.
  - **workflows** — `actionlint`, `zizmor` (online, with
    `GITHUB_TOKEN`), and `pinact run --check` over `.github/`. It runs on
    every run rather than behind a `paths:` filter, so it is always
    present as a check and can be required; it is seconds of work.
- Best practice, each of these verifiable by reading the file or by the
  linters:
  - every `uses:` pinned to a full commit SHA with the version in a
    trailing comment (pinact's format), never a floating tag;
  - `permissions: { contents: read }` at the top of the workflow; a job
    adds only what it needs;
  - a `concurrency` group per ref with `cancel-in-progress: true`;
  - `timeout-minutes` on every job;
  - no `pull_request_target`, no secrets in the gate, no
    `${{ github.event.* }}` interpolated into `run:` (zizmor's
    `template-injection`);
  - `.github/dependabot.yml` covering the `github-actions` ecosystem, so
    the pins move by PR rather than by hand.
- The same linters run locally, behind the same three-command contract:
  `actionlint`, `zizmor`, and `pinact` pinned in `mise.toml`, and `pnpm
  lint` extended to run them over `.github/` (zizmor `--offline` locally)
  so a workflow that would fail CI fails at the desk first. A repo-level
  hk configuration runs them in the pre-commit hook for staged workflow
  files, alongside the operator's global gitleaks step — whether hk
  merges a project `hk.pkl` with `~/.config/hk/config.pkl` or replaces
  it is to be established, and the answer written into the file.
- AGENTS.md: retire "there is no CI"; add the workflow linters to the
  toolchain section and the `.github/` path to the repo map.

## Acceptance criteria

- [x] `pnpm lint` from the repo root runs actionlint, zizmor, and pinact
      over `.github/` and passes; a deliberately unpinned `uses:` or a
      `run:` interpolating `github.event.*` makes it fail, with the tool's
      own message.
- [x] A commit touching `.github/workflows/*.yml` runs the same linters
      in the pre-commit hook.
- [x] Every `uses:` in the repo is SHA-pinned with a version comment;
      `pinact run --check` and zizmor's `unpinned-uses` audit are clean.
- [ ] On GitHub, a push to `main` runs both jobs green — observed through
      `gh run` — and a workflow change that breaks a rule fails the
      `workflows` job on a push of its own before being reverted. The
      operator has allowed pushing `main` for exactly this (PROMPT.md);
      the repo is still private, which CI does not mind.
- [x] AGENTS.md no longer claims there is no CI, and names the linters.

## Out of scope

The release half — tags, artifacts, attestations ([041](041-release-pipeline.md)).
Branch protection and required checks — the operator sets those in the
repository settings once the check names exist. Running the workflow
locally with `act`.
