---
id: "001"
title: Repository scaffold and toolchain
status: todo
component: .
language: none
depends_on: []
blocks: ["002", "003", "004"]
parallel_safe: false
---

# Repository scaffold and toolchain

## Context

Every other task lands inside this structure. It blocks the entire graph, so keep it
minimal: directories, build wiring, and stubs that compile. No behavior.

## Scope

Set up a pnpm workspace alongside a Go module:

```
thicket/
  package.json            # workspace root, private
  pnpm-workspace.yaml
  tsconfig.base.json
  packages/{roster,executor,slack-manifest}/
  apps/{agentd,bridge,cli}/
  netd/                   # go.mod lives here
  deploy/{systemd,launchd}/
  agents.yaml             # example, one agent
  docs/
```

- TypeScript strict mode, ESM, Node 18+ target. Composite project references so
  `packages/*` build before `apps/*`.
- Each package exports a stub and has a passing no-op test.
- Go module `netd` with a `main` that builds and exits.
- Single commands at the root: `pnpm build`, `pnpm test`, `pnpm lint`, and `pnpm
  build:netd` shelling out to `go build ./netd/...`.
- Pin toolchain versions via mise (`mise.toml`) — Node and Go.
- `.gitignore` covering `node_modules`, `dist`, compiled Go binaries.

## Acceptance criteria

- [ ] `pnpm install && pnpm build && pnpm test && pnpm lint` succeeds from a clean clone.
- [ ] `pnpm build:netd` produces a binary.
- [ ] `apps/agentd` can import a symbol from `packages/roster` and typecheck; the
      dependency graph in `000-overview.md` is expressible in `package.json` deps.
- [ ] `mise install` provisions the pinned Node and Go versions.
- [ ] Importing `apps/bridge` from `packages/*` is a build error (dependency direction
      is enforced, not merely documented).

## Out of scope

Any runtime behavior. CI configuration. Container images.
