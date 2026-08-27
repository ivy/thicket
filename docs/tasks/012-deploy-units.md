---
id: "012"
title: Deployment units and bootstrap
status: done
component: deploy
language: none
depends_on: ["003", "008", "010"]
blocks: ["013"]
parallel_safe: false
---

# Deployment units and bootstrap

## Context

Agents run as systemd **user** units so each account owns its own lifecycle: no root to
deploy, restart, or inspect an agent. The unix user is the instance, so no `%i`
templates are needed — the same unit file is dropped into each account.

## Scope

**Units**, per agent account:

```
~/.config/systemd/user/thicket-netd.service      # holds the tailnet identity
~/.config/systemd/user/thicket-agentd.socket     # systemd owns the unix socket
~/.config/systemd/user/thicket-agentd.service    # socket-activated
```

Let systemd own the socket rather than `agentd` creating it: `netd` can then start
before `agentd`, ordering is handled, and activation is lazy. `agentd` stays resident
once started — its hot session pool is the point.

Use specifiers rather than hardcoded paths: `%S` for state, `%t` for runtime, `%h` for
home.

Bridge account gets `thicket-bridge.service` plus its own `thicket-netd.service`.

**Lingering.** User managers only run while a session exists. Without

```
sudo loginctl enable-linger ivy grove hearth
```

nothing starts at boot and nothing survives logout. This is the single most common way
a user-unit deployment silently fails — make it a documented bootstrap step and a
`doctor` check.

**Laptop.** Equivalent launchd plists for macOS with `KeepAlive` and the same XDG paths.
No socket activation; `agentd` creates its own socket there.

**Hardening.** Apply what makes sense for user units: `NoNewPrivileges`,
`PrivateTmp`, `ProtectSystem=strict` with `ReadWritePaths` for state, and
`RestartSec` with backoff.

**Bootstrap doc.** `deploy/README.md` covering a new agent end to end: create the unix
account, enable lingering, mint a tagged auth key, run `thicket provision`, install the
Slack app, start the units, verify with `doctor`.

## Acceptance criteria

The live-host criteria below require a Linux machine with systemd, a tailnet,
and a Slack workspace; none exist in this repo's test environment. They are
verified during task 013's first-agent bring-up, which runs `deploy/README.md`
end to end. What is verifiable in-repo — syntax, portability, and the
invariants the runtime behavior depends on — is enforced by `deploy/check.sh`.

- [x] `deploy/README.md` covers a new agent end to end (account, lingering,
      tagged auth key, provision, app install, binaries, units, doctor) with no
      undocumented steps; live walk-through happens in task 013.
- [x] Lingering is a documented bootstrap step and a doctor check (task 010);
      boot-with-no-session behavior is observed in task 013.
- [x] Units run entirely as the user (user units, `%h`-relative paths, no
      sudo anywhere in the unit files); `systemctl --user status` inspection is
      observed in task 013.
- [x] netd and agentd are independent units with no lifecycle coupling beyond
      the socket unit, so stopping/restarting `thicket-netd` cannot kill
      `thicket-agentd` (verified structurally: no Requires/BindsTo between
      them); live reachability toggling is observed in task 013.
- [x] Socket activation is wired: systemd owns `%t/thicket/agentd.sock` at
      mode 0600, `thicket-agentd.service` requires the socket and has no
      install section, and agentd's LISTEN_FDS path is tested in task 008;
      the through-netd activation round trip is observed in task 013.
- [x] `thicket-agentd.service` restart does not touch `thicket-netd.service`
      (no dependency edge in either direction; enforced by `deploy/check.sh`
      structure checks).
- [x] Unit files and plists contain no hardcoded home directories or
      usernames — the same file works in every account (`deploy/check.sh`
      greps for `/home/`, `/Users/<name>`, and `%i`).
- [x] macOS plists lint clean (`plutil -lint`) and declare `RunAtLoad` plus
      `KeepAlive.SuccessfulExit=false` — start at login, restart on failure;
      live login behavior is observed in task 013 where a laptop agent exists.

## Out of scope

Configuration content (task 010 writes it). CI/CD. Container images.
