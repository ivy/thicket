---
id: "010"
title: CLI — provision and doctor
status: done
component: apps/cli
language: typescript
depends_on: ["002", "007"]
blocks: ["012"]
parallel_safe: true
---

# CLI — provision and doctor

## Context

`agents.yaml` in git is the source of truth; everything else is generated. This command
turns it into Slack apps, per-account configuration, and tailnet identities. It runs at
deploy time, never in the request path.

## Scope

**`thicket provision [--dry-run] [--agent NAME]`**

1. Render Slack manifests (task 007).
2. Create or update each app via `apps.manifest.create` / `apps.manifest.update` using
   an app configuration token. Store the returned `app_id` and credentials.
3. Print the `oauth_authorize_url` for apps needing installation.
4. Write per-account config into each agent's `~/.config/thicket/config.yaml`.
5. Report which agents still need a manual icon upload.

App configuration tokens expire 12 hours after generation and are refreshed with
`tooling.tokens.rotate`. Refresh automatically and persist the rotated pair; a run that
dies mid-way must not strand the operator with a dead token.

`apps.manifest.create` is Tier 1 rate limited (1+/minute) — provisioning several agents
must pace itself rather than burst and fail.

**`thicket doctor`** — check and report, never mutate:

- Roster parses; no duplicate names, tags, or `(host, user)` pairs.
- Each agent's card is fetchable and parses.
- Each expected tailnet node exists and carries the expected tag.
- Each Slack app exists, is installed, and has Socket Mode enabled.
- Installed Slack app count against the workspace limit — the free plan caps at 10
  third-party or custom app installations, shared with everything else installed.
- Lingering is enabled for each agent account (task 012), since without it nothing
  starts at boot.

**Secret handling.** Credentials go to files at mode 0600 under
`~/.config/thicket/`. Never log a token, never write one to stdout, never commit one.

## Acceptance criteria

- [x] `--dry-run` prints the diff between current and desired app configuration and
      makes no API calls that mutate.
- [x] Running `provision` twice with an unchanged roster is a no-op — no spurious
      `apps.manifest.update` calls.
- [x] Changing one agent's description updates only that app.
- [x] Config token rotation happens transparently; a run longer than the token lifetime
      completes.
- [x] Provisioning four agents respects the Tier 1 rate limit and does not fail on
      `ratelimited`.
- [x] `doctor` detects and reports, with distinct messages: a missing tailnet tag, an
      uninstalled Slack app, a stale card, an account without lingering, and being at
      the workspace app cap.
- [x] `doctor` exits non-zero when any check fails, zero when all pass.
- [x] No token value appears in any log line or terminal output.

## Out of scope

Writing systemd units (task 012). Uploading Slack icons — no API path exists.
