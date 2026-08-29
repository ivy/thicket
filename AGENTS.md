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

pnpm workspace (`packages/*`, `apps/*`, `tests/*`) plus one Go module.

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
| `docs/tasks/` | The work queue — one file per task, status in YAML frontmatter |

`agents.yaml` is the source of truth. Manifests, per-account config, and tailnet
identities are all rendered from it; anything hand-edited afterwards is a generator bug.

## How to work here

Toolchain is pinned in `mise.toml` — prefix commands with `mise exec --`.

```sh
mise exec -- pnpm install
mise exec -- pnpm build      # tsc -b across the workspace
mise exec -- pnpm test       # builds first, then `pnpm -r test`
mise exec -- pnpm lint       # eslint .
mise exec -- pnpm build:netd && go test ./netd/...
```

Before landing anything: **build, test, lint — all three, from the repo root.** There is
no CI; these commands are the only gate.

Two traps worth knowing:

- **Tests run from compiled `dist/`,** so a stale build tests the previous commit. Use
  `pnpm test` (it builds) rather than calling `node --test` directly.
- **Run from the repo root.** Scripts differ per member, and workspace imports do not
  resolve from a package directory.

## Change hygiene

- Read [PROMPT.md](PROMPT.md) if you are working the task queue. It governs: one task
  per iteration, claim it before starting, check an acceptance box only against observed
  behaviour.
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

- [docs/tasks/000-overview.md](docs/tasks/000-overview.md) — the dependency graph, the
  current wave, and hard-won external facts (Slack API quirks, A2A semantics).
- [docs/tasks/LIVE-TESTING.md](docs/tasks/LIVE-TESTING.md) — the local rig, the two
  Slack MCP servers, and what still needs a human. **Read before any live check.**
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
