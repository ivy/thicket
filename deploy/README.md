# Deploying a thicket agent

One agent = one unix account = one tailnet node = one Slack app. Everything below
runs **as that account or as the operator** — never as root except where marked.

The bridge is deployed the same way (its own account, its own `netd`), swapping
`thicket-bridge.service` for the agentd socket/service pair.

## 0. Prerequisites

- A Linux host with systemd (user units) and internet access, or a Mac (see
  [macOS](#macos)).
- The operator machine has this repo checked out with `mise install` run and
  `pnpm build && pnpm compile && pnpm build:netd` passing.
- A Slack workspace where you can create apps, and an
  [app configuration token](https://api.slack.com/authentication/config-tokens)
  (they expire after 12 hours; the CLI rotates them automatically once seeded).
- A tailnet you administer, with ACL tag owners configured for `tag:thicket-*`.

## 1. Create the unix account (root, once per agent)

```sh
sudo useradd --create-home --shell /bin/bash hearth
```

## 2. Enable lingering (root, once per agent) — DO NOT SKIP

```sh
sudo loginctl enable-linger hearth
```

User managers only run while a session exists. Without lingering **nothing
starts at boot and everything dies at logout** — this is the single most common
way a user-unit deployment silently fails. `thicket doctor` checks it.

## 3. Mint a tagged tailnet auth key (operator)

In the tailscale admin console (or via API), create an auth key that:

- is **tagged** with this agent's tag, e.g. `tag:thicket-hearth` (the key must
  own the tag or `netd` will refuse to start),
- is reusable or single-use per your rotation policy.

Install it for the account:

```sh
sudo -u hearth mkdir -p ~hearth/.config/thicket
sudo -u hearth sh -c 'umask 077; cat > ~/.config/thicket/tailnet-auth-key'   # paste key, ^D
```

## 4. Provision Slack apps and config (operator)

Seed the config token once (the CLI keeps it fresh from then on):

```sh
mkdir -p ~/.config/thicket
umask 077
cat > ~/.config/thicket/slack-config-token.json <<'EOF'
{ "token": "xoxe...", "refreshToken": "xoxe-1-...", "exp": 1756300000 }
EOF
```

Then, with `agents.yaml` in `~/.config/thicket/`:

```sh
thicket provision --dry-run   # review the plan
thicket provision             # create/update apps, render per-account config
```

- Follow each printed `install <agent>: https://...` link to install the app.
- Upload icons by hand for any agent listed under "manual step" (Slack has no
  API for this).
- Copy the rendered tree onto the agent host:

```sh
scp -r ~/.config/thicket/rendered/hearth/ host:/tmp/hearth-config
sudo -u hearth cp -r /tmp/hearth-config/. ~hearth/.config/thicket/
```

## 5. Install binaries (as the agent account)

Every thicket process is a single executable: the account needs no JavaScript
runtime and no checkout, only the Claude Code CLI the harness drives.

```sh
mkdir -p ~/.local/bin
# netd (single Go binary)
cp /path/to/repo/netd/bin/netd ~/.local/bin/thicket-netd
# agentd, bridge and the CLI, compiled by `pnpm compile --all` on a build
# machine. bun-linux-x64 here; bun-darwin-arm64 on a Mac.
cp /path/to/repo/dist-bin/bun-linux-x64/thicket-agentd ~/.local/bin/
cp /path/to/repo/dist-bin/bun-linux-x64/thicket-bridge ~/.local/bin/
cp /path/to/repo/dist-bin/bun-linux-x64/thicket        ~/.local/bin/
# Claude Code CLI for the harness. agentd resolves it on PATH at startup and
# logs which one it found; `claude_executable` in agentd.json overrides that.
mise use -g "npm:@anthropic-ai/claude-code"
```

## 6. Install and start the units (as the agent account)

```sh
mkdir -p ~/.config/systemd/user
cp /path/to/repo/deploy/systemd/thicket-netd.service \
   /path/to/repo/deploy/systemd/thicket-agentd.socket \
   /path/to/repo/deploy/systemd/thicket-agentd.service \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now thicket-agentd.socket thicket-netd.service
```

`thicket-agentd.service` has no install section on purpose: the socket starts
it on the first request, and it stays resident after that (the hot session
pool is the point).

**This does not work under Bun today.** Bun cannot listen on a descriptor it
did not open, so an agentd handed one refuses to start rather than coming up
mute. Until [047](../docs/tasks/047-socket-activation-after-bun.md) settles
what replaces activation, a Linux host has to start `thicket-agentd.service`
directly and let agentd create its own socket, as launchd already does.

The bridge account instead installs `thicket-bridge.service` (plus its own
`thicket-netd.service`) and enables both.

### The bridge's netd faces inward too

The bridge's netd was already there for egress. Attachments also need the
reverse: an agent fetches the bytes of a file a human uploaded, because the
bot token that redeems Slack's private URL lives only in the bridge. So point
that netd's upstream at the bridge instead of at an agentd that does not exist
in this account, in `~/.config/thicket/netd.json`:

```json
{
  "hostname": "thicket-bridge",
  "tag": "tag:thicket-bridge",
  "upstream_socket": "/run/user/1001/thicket/bridge.sock"
}
```

and write the bridge's own config, `~/.config/thicket/bridge.json`:

```json
{
  "file_base_url": "https://thicket-bridge.tailXXXX.ts.net",
  "agents": {
    "hearth": { "app_token": "xapp-...", "bot_token": "xoxb-..." }
  }
}
```

`agents` is required: one entry per agent this bridge serves. Neither token
comes from `provision`, because neither exists until the app is installed.
Once it is, both are on that app's own page — Basic Information →
App-Level Tokens, generated with the `connections:write` scope, gives the
`xapp-`; OAuth & Permissions gives the bot `xoxb-`. Mode 0600.

Omit `file_base_url` and the file surface never binds: attachments are
declined in-thread rather than turned into links nothing can follow.

This needs an ACL edge that did not exist before — agents dial the bridge,
where previously only the bridge dialed agents. Authorization is still a tag
read plus a lookup in the bridge's own state, so an agent can fetch only files
uploaded to its own threads, and no token is minted or distributed. Note that
`thicket-netd.service` carries `Wants=thicket-agentd.socket`; in the bridge
account that unit is absent, which systemd tolerates.

## 7. Verify

```sh
systemctl --user status thicket-netd thicket-agentd.socket   # as the account
thicket doctor                                               # as the operator
```

`doctor` checks the roster, each card, tailnet tags, Slack app state, the
workspace app cap, and lingering — and exits non-zero on any failure.

Useful spot checks:

```sh
# socket activation: with agentd stopped, a request must start it
systemctl --user stop thicket-agentd.service
curl --unix-socket "$XDG_RUNTIME_DIR/thicket/agentd.sock" http://x/.well-known/agent-card.json
systemctl --user status thicket-agentd.service   # now running

# agentd restarts independently of netd
systemctl --user restart thicket-agentd.service  # netd untouched
```

## macOS

No systemd: use the launchd plists. No socket activation either — `agentd`
creates its own 0600 socket.

```sh
cp /path/to/repo/deploy/launchd/com.thicket.netd.plist \
   /path/to/repo/deploy/launchd/com.thicket.agentd.plist \
   ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.thicket.netd.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.thicket.agentd.plist
```

`RunAtLoad` starts them at login; `KeepAlive.SuccessfulExit=false` restarts
them on failure. Logs land in `~/Library/Logs/thicket-*.log`.

## Sanity rules

- Unit files and plists contain **no hardcoded usernames or home paths** —
  the same files work in every account. `deploy/check.sh` enforces this.
- Config is rendered by `thicket provision`, never hand-edited; if you need to
  hand-edit, the generator has a bug.
- Secrets (`tailnet-auth-key`, `slack-config-token.json`, bridge tokens) are
  mode 0600 and never committed.
