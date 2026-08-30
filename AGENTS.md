# AGENTS.md

## Purpose

- **thicket** puts an AI agent on every system the operator runs, reachable from Slack
  or from Claude Code, and able to reach each other. See [README.md](README.md).
- An agent is a `(host, unix user)` pair — a trust boundary, not a personality. The
  roster grows when a new blast radius is needed, never when a new skill is.
- [docs/vision.md](docs/vision.md) is binding. It settles most design arguments before
  they start; read it before proposing anything structural.
- Success is an agent you can trust unattended. That means correct failure behaviour
  matters more than features.

## Repo map

pnpm workspace (`packages/*`, `apps/*`, `tests/*`) plus one Go module. Bun is the
runtime: it executes the TypeScript directly and compiles it into the standalone
binaries an agent account installs.

| Path | Role |
|---|---|
| `packages/roster/` | `agents.yaml` → `AgentCard`; the shared contract, and XDG paths |
| `packages/executor/` | Claude Agent SDK frame stream → A2A task events |
| `packages/slack-manifest/` | `AgentCard` → Slack app manifest |
| `apps/agentd/` | A2A server + session manager; binds a unix socket, never a port |
| `apps/bridge/` | Slack Socket Mode ⇄ A2A, plus the file surface agents fetch from |
| `apps/cli/` | `provision`, `doctor`, `fleet`, `mcp`, `slack-test-mcp` |
| `netd/` | Go; tsnet node per agent, tailnet ⇄ unix socket with verified peer tags |
| `tests/integration/` | Real agentd + real bridge over HTTP; only Slack is faked |
| `deploy/` | systemd units, launchd plists, and `deploy/dev/` stand-ins |
| `.github/` | The CI gate and the Dependabot policy that moves its action pins |
| `scripts/compile.ts` | `bun build --compile` → `dist-bin/<target>/{thicket,thicket-agentd,thicket-bridge}` |

`agents.yaml` is the source of truth. Manifests, per-account config, and tailnet
identities are all rendered from it; anything hand-edited afterwards is a generator bug.

## How to work here

Toolchain is pinned in `mise.toml` — prefix commands with `mise exec --`.

```sh
mise exec -- pnpm install
mise exec -- pnpm build      # tsc -b: the typecheck, declarations only
mise exec -- pnpm test       # bun test, straight from src/
mise exec -- pnpm lint       # eslint, gofmt + go vet, then the .github/ linters
mise exec -- pnpm build:netd && go test ./netd/...
mise exec -- pnpm compile    # standalone binaries; --all for every fleet platform
```

Before landing anything: **build, test, lint — all three, from the repo root.**
`.github/workflows/ci.yml` runs exactly those on every push to `main` and every pull
request, in a `gate` job; a `workflows` job re-runs the three workflow linters —
[actionlint](https://github.com/rhysd/actionlint) (syntax, expressions, shellcheck over
every `run:`), [zizmor](https://github.com/zizmorcore/zizmor) (security: unpinned
`uses:`, template injection, over-broad permissions) and
[pinact](https://github.com/suzuki-shunsuke/pinact) (`uses:` pinned to a commit SHA).
Those three are also in `pnpm lint` and in the pre-commit hook, so a workflow that would
fail CI fails at the desk first. `pnpm lint` covers the Go module too — `gofmt -l` over
`netd/`, then `go vet` — so `go test` is not the only thing that reads it.

A tag is a release. Pushing `v*` runs the same gate, then builds one archive per fleet
platform — `bin/` holding all four executables — attests them, and creates the release;
`.github/workflows/verify-release.yml` then installs it the way an agent account does,
and can be dispatched by hand against any tag. Deploying is repinning:
`mise use -g github:ivy/thicket@1.2.3`. Build provenance needs the repository to be
public — see [#15](https://github.com/ivy/thicket/issues/15).

Two traps worth knowing:

- **The rig runs `dist-bin/`, not `src/`.** A live check measures the binaries, so
  `pnpm compile` before `./deploy/dev/rig.sh restart` or you are testing the last
  compile. `dist/` holds declarations only; nothing executes from it.
- **Run from the repo root.** Scripts differ per member, and workspace imports do not
  resolve from a package directory.

## Change hygiene

- The work queue is [GitHub issues](https://github.com/ivy/thicket/issues). Read
  [PROMPT.md](PROMPT.md) if you are working it: one issue per iteration, assign yourself
  before starting, check an acceptance box only against observed behaviour.
- **Never run `thicket provision`.** It mutates a live Slack workspace against a Tier 1
  rate limit and needs a browser reinstall no automation can perform. Change the
  renderer, land it, and say a provision is owed.
- Keep diffs to the task at hand. No drive-by refactors of neighbouring code.
- Comments explain *why*. Documents state current facts — revision history belongs in
  the commit message, not the file.
- Never commit secrets. Token files live outside the repo, mode 0600, and are written by
  the operator.
- When a live check fails in a way the code cannot explain, add the missing log line
  rather than guessing. Every mystery in this project so far ended at a path that
  recorded nothing.

## Deeper docs

- [GitHub issues](https://github.com/ivy/thicket/issues) — the work queue. A `blocked`
  label means the operator must act before that one can move.
- [docs/reference.md](docs/reference.md) — runtime topology, conventions, and hard-won
  external facts (Slack API quirks, A2A semantics).
- [docs/phone-bridge.md](docs/phone-bridge.md) — the phone bridge design the `M0`–`M3`
  milestones assume: the operator console, its PIN gate, identity, the call, and the vendor facts.
- [docs/live-testing.md](docs/live-testing.md) — the local rig, the two Slack MCP
  servers, and what still needs a human. **Read before any live check.**
- [docs/runbook.md](docs/runbook.md) — what to do when an agent stops responding, a
  socket will not reconnect, or a task is stuck in `working`.
- [deploy/README.md](deploy/README.md) — real deployment: accounts, units, tailnet
  identity, and the bridge's inbound netd.

## Where to look first

- **A Slack behaviour is wrong** → `apps/bridge/src/engine.ts` (policy) and
  `slack-api.ts` (the API surface, which logs every call it makes).
- **An agent's reply is wrong or missing** → `packages/executor/src/translator.ts`, the
  seam where SDK frames become A2A events. Turn boundaries are not message boundaries.
- **Something about identity, paths, or capability** → `packages/roster/src/`.
- **Reproducing anything end to end** → `./deploy/dev/rig.sh restart`, then
  `tail -f ~/thicket-test/bridge.log`.
