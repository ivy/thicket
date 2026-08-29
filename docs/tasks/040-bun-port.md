---
id: "040"
title: Bun port — one runtime, standalone executables
status: in-progress
component: .
language: typescript
depends_on: ["046"]
blocks: ["041"]
parallel_safe: false
---

# Bun port

## Context

The deploy model is versioned artifacts pulled by mise; standalone
executables are what remove Node, the repo checkout, and `pnpm build` from
every agent account. The project is young enough that revalidation is cheap —
but the risk concentrates exactly where the scars are: the
`@slack/socket-mode` reconnection behaviour and the Agent SDK's
subprocess/MCP quirks in 000-overview's external-facts table were all
observed under Node. The port is not done when it compiles; it is done when
those facts are re-observed under Bun.

It lands under CI ([046](archived/046-ci-gate-and-workflow-lint.md)) rather than
before it: a change to the whole toolchain is the one that most needs the
gate run by something other than the person making it. The three-command
contract is what keeps the workflow valid across the port.

There is a structural win available too: Bun executes TypeScript directly,
so the "tests run from compiled `dist/`, a stale build tests the previous
commit" trap can disappear rather than be worked around.

## Scope

- Pin `bun` in `mise.toml`; move the workspace scripts to Bun equivalents.
  The contract stays: **build, test, lint — three commands from the repo
  root** (build may become a no-op or a typecheck; whether tests stay on
  `node:test` under Bun's compat layer or move to `bun test` is an
  implementation decision).
- `bun build --compile` for the three TS executables — `thicket` (cli),
  `thicket-agentd`, `thicket-bridge` — for the platforms the fleet actually
  has (Fedora server, macOS arm64).
- `tests/integration` green with agentd and the bridge executing under Bun —
  this suite is the instrument that answers the runtime question.
- A live soak through the dev rig (`./deploy/dev/rig.sh`): streaming, an
  attachment, and a socket-liveness observation.
- Re-verify the runtime-sensitive rows of 000-overview's external-facts
  table (socket-mode ping/retry bounding, one MCP server instance per
  session, AskUserQuestion deferral) and annotate them with what was
  re-observed.
- Update AGENTS.md's toolchain commands and traps to match reality.

## Acceptance criteria

- [ ] Build, test, and lint run from the repo root under Bun and are
      documented in AGENTS.md as run.
- [ ] `tests/integration` passes with the apps running under Bun.
- [ ] Compiled standalone binaries drive the dev rig end to end — a Slack
      message in, a streamed reply out — with no Node on PATH.
- [ ] The runtime-sensitive external-facts rows are re-verified and
      annotated.

## Out of scope

The release workflow ([041](041-release-pipeline.md)). `netd` — already a
static Go binary. The `claude-code` CLI each account installs — its own
tool, its own pin.
