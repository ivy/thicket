---
id: "012"
title: Deployment units and bootstrap
status: todo
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

- [ ] A fresh unix account reaches a running agent by following `deploy/README.md`
      with no undocumented steps.
- [ ] After `enable-linger` and a reboot, both units come up with no login session.
- [ ] `systemctl --user status thicket-agentd` is informative as that user, with no sudo.
- [ ] Stopping `thicket-netd` leaves the agent unreachable over the tailnet but does not
      kill in-flight local work; restarting it restores reachability.
- [ ] Socket activation works: with `thicket-agentd.service` stopped, a request through
      `netd` starts it and succeeds.
- [ ] Restarting `thicket-agentd` does not require restarting `thicket-netd`.
- [ ] Unit files contain no hardcoded home directories or usernames — the same file
      works in every account.
- [ ] macOS plists start both processes at login and restart them on failure.

## Out of scope

Configuration content (task 010 writes it). CI/CD. Container images.
