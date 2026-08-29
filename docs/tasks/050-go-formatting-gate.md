---
id: "050"
title: The gate lints TypeScript but not Go
status: in-progress
component: .
language: none
depends_on: []
blocks: []
parallel_safe: true
---

# The gate lints TypeScript but not Go

## Context

`pnpm lint` runs eslint over the workspace and three linters over `.github/`.
Nothing looks at the Go module. `pnpm build:netd` and `go test ./netd/...`
compile and run it, and neither cares about formatting.

The consequence is already in the tree: `netd/config_test.go` is committed
unformatted, and `gofmt -l netd/` has presumably been reporting it since it
landed, unread.

```
$ gofmt -l netd/
netd/config_test.go
```

`go vet ./netd/...` is clean today, which is luck rather than policy — nothing
would notice if it stopped being.

## Scope

- `gofmt -l` over the Go module, failing when it names any file, and
  `go vet ./netd/...`, both reachable from the repo root and both in the
  gate alongside the existing checks.
- Where they live is an implementation decision — a `lint:go` script beside
  `lint:js` and `lint:workflows` is the obvious shape, but the gate job
  already runs Go commands directly and either is defensible.
- Reformat `netd/config_test.go` so the new check passes.

## Acceptance criteria

- [x] `pnpm lint` from the repo root fails on unformatted Go and on a `go vet`
      finding, with the tool's own message.
- [x] `gofmt -l netd/` is empty and `go vet ./netd/...` is clean.
- [ ] CI runs both, observed green through `gh run`.

## Out of scope

A third-party Go linter (golangci-lint, staticcheck) — more opinions than this
module has earned. Formatting or vetting anything outside the Go module.
