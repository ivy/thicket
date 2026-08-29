---
id: "039"
title: Open the repo — ISC license, README, and a clean history
status: done
component: .
language: none
depends_on: []
blocks: ["041"]
parallel_safe: true
---

# Open the repo

## Context

The repo lives at `ivy/thicket` on GitHub, private, with a small history.
The decision is to build in the open: public releases are what let every
agent account pull artifacts with no per-account token
([041](041-release-pipeline.md)), and the pre-publication scrub costs minutes
now where in six months it would be an audit. The committed `agents.yaml` is
already an example roster; the real one lives in `~/.config/thicket/`, and
token files have lived outside the repo from the start.

## Scope

- `LICENSE` at the root: ISC, `Copyright (c) 2026 Ivy Evans`.
- A README pass for a public reader: what thicket is, links to
  [vision](../vision.md) and [roadmap](../roadmap.md), and one sentence
  setting expectations — one operator's fleet, built in the open; issues
  welcome, the roadmap is the operator's.
- A history-wide secrets scan (gitleaks or trufflehog, over every commit).
  Rewrite history only if something is found; nothing should be.
- Skim the leak-prone docs — `docs/tasks/`, `LIVE-TESTING.md`,
  `docs/runbook.md` — for identifiers that should not publish: Slack team and
  channel IDs, tailnet hostnames, personal paths.
- Operator handoff: flipping the repo public is the operator's act. The task
  ends with a ready-to-flip note recording what was checked and with which
  tools.

## Acceptance criteria

- [x] `LICENSE` (ISC) exists; README links vision and roadmap and states the
      built-in-the-open expectation. Root `package.json` carries
      `"license": "ISC"`; the README's status and requirements sections now
      say what is true (running on one host; toolchain from `mise.toml`).
- [x] The full-history secrets scan ran clean; tool and invocation recorded
      below.
- [x] The docs skim found nothing unpublishable, or what it found was fixed.
      Found and fixed: a workspace permalink (team subdomain + DM channel id)
      in `docs/tasks/archived/015-*.md`, replaced with prose; `HANDOFF.md`,
      a stale session handoff carrying the Slack app id, workspace name,
      and absolute personal paths, removed — everything it said that still
      holds lives in `AGENTS.md`, the runbook, and the task files.
- [x] The public flip is documented as the operator step — not performed.

## Out of scope

The release workflow ([041](041-release-pipeline.md)). Renaming the local
checkout directory — cosmetic, operator's call.

## Ready to flip

Checked 2026-08-28, all from the repo root:

**Secrets, whole history.** gitleaks 8.30.1, every commit on every ref
(117 commits):

```sh
gitleaks git --no-banner --redact --log-opts="--all" .
#   runs: git log -p -U0 --all → no leaks found
git log --all -p --no-color | gitleaks stdin --no-banner --redact
#   1.79 MB of raw diffs → 8 findings, all false positives, each read:
#   5 × sourcegraph-access-token on the `commit <sha>` header lines of the
#       piped log itself (a 40-hex hash, not file content)
#   3 × generic-api-key on Go module checksums (`h1:…`) in go.work.sum
#       and netd/go.sum — the go.sum allowlist gitleaks' git mode applies
```

(gitleaks' git mode prints "0 commits scanned" and a debug note that the
counter undercounts; the bytes scanned and the debug-logged `git log`
command show it walked the history. The stdin pass is the independent
check.)

**Identifiers, tracked files.** `git grep` for Slack id shapes
(`[TCDUBGA][0-9A-Z]{8,11}`), the known team/app/channel/user ids,
`*.ts.net` hostnames, `xox[bpa]-`/`sk-ant` token shapes, `/Users/` and
`/home/` paths, and the operator's name and email: what remains is test
fixtures (`example.ts.net`, `xoxb-hearth`, `U-human`), the ISC copyright
line, `github:ivy/thicket` install pins, the example roster's
`/home/thicket-example`, and the Slack MCP client id that Slack itself
publishes (LIVE-TESTING.md says so where it appears).

**Not in the repo, by design.** Token files (`~/.config/thicket/*.json`,
mode 0600) and the real roster; the committed `agents.yaml` is the example.
`.claude/settings.json` holds only the plugin enablement; `.mcp.json` only
the dev harness command.

**The operator's step.** On GitHub: `ivy/thicket` → Settings → General →
Danger Zone → *Change visibility* → Public. Nothing here pushes: the local
`main` is ahead of the remote, so push first, then flip. After the flip,
[041](041-release-pipeline.md) can rely on public release assets.
