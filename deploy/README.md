# Deploying a thicket agent

One agent = one unix account = one tailnet node = one Slack app. Everything below
runs **as that account or as the operator** — never as root except where marked.

The bridge is deployed the same way (its own account, its own `netd`), swapping
`thicket-bridge.service` for `thicket-agentd.service`.

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

`provision` is for the Slack half: it is rate-limited, it wants a browser for
the installs, and it should happen rarely and deliberately. The per-account
config is not like that — it is regenerated whenever the roster, the tailnet
domain, or anything else it derives from moves. That half has its own command,
which reads a roster and writes files and touches nothing else:

```sh
thicket render                     # into ~/.config/thicket/rendered
thicket render --out /tmp/staging  # somewhere a deploy can stage from
```

Deployment automation should call `render`, never `provision`.

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
# machine. linux-x64 here; macos-arm64 on a Mac.
cp /path/to/repo/dist-bin/linux-x64/thicket-agentd ~/.local/bin/
cp /path/to/repo/dist-bin/linux-x64/thicket-bridge ~/.local/bin/
cp /path/to/repo/dist-bin/linux-x64/thicket        ~/.local/bin/
# Claude Code CLI for the harness. agentd resolves it on PATH at startup and
# logs which one it found; `claude_executable` in agentd.json overrides that.
mise use -g "npm:@anthropic-ai/claude-code"
```

## 6. Install and start the units (as the agent account)

```sh
mkdir -p ~/.config/systemd/user
cp /path/to/repo/deploy/systemd/thicket-netd.service \
   /path/to/repo/deploy/systemd/thicket-agentd.service \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now thicket-agentd.service thicket-netd.service
loginctl enable-linger "$USER"   # so the units survive logout
```

The bridge account instead installs `thicket-bridge.service` (plus its own
`thicket-netd.service`) and enables both.

### Who creates the socket, and what a caller in the gap sees

agentd does, at `$XDG_RUNTIME_DIR/thicket/agentd.sock`, mode 0600, inside the
0700 `RuntimeDirectory=` its unit owns. There is no `.socket` unit and no
socket activation: Bun will not listen on a descriptor it did not open, and
agentd refuses that path outright rather than starting up mute.

Nothing needs to be ordered against it. netd dials that path once per
request, not once at startup, so a request arriving before agentd is up gets
`502 Bad Gateway` and the next one is served — no restart, no retry loop, no
`After=`. The cost of dropping activation is exactly that window, which is
the seconds between the two units starting.

If a host still has an old `thicket-agentd.socket` unit enabled, agentd will
refuse to start and say so, naming `LISTEN_FDS`. Disable it:

```sh
systemctl --user disable --now thicket-agentd.socket
rm ~/.config/systemd/user/thicket-agentd.socket
systemctl --user daemon-reload
```

### Egress is deny-by-default

netd's second socket is the way out for a process that has none of its own.
It is a policy point, not a relay: it reaches only the destinations
`egress_allow` names in `netd.json`, and an account whose config lists none
has no egress at all.

```json
{
  "hostname": "thicket-hearth",
  "tag": "tag:thicket-hearth",
  "auth_key_file": "tailnet-auth-key",
  "egress_allow": ["thicket-bridge.tailXXXX.ts.net", "thicket-forge.tailXXXX.ts.net"]
}
```

An entry is a hostname, or `*.example.com` for the names under a domain — the
domain itself is not one of them. `provision` renders the list from
`agents.yaml`, so hand-editing it is a bug in the generator.

Two properties are worth knowing before reading the logs:

- **Names only.** A `CONNECT` to an address is refused even when that address
  is exactly where an allowed name leads, because netd is the one that
  resolves — the process behind it never handles DNS, and a rule is written
  about a name.
- **Two routes.** A short MagicDNS name, or one under the tailnet's own
  suffix, is dialed through tsnet and arrives carrying this node's tag.
  Everything else leaves through the host's network stack.

netd prints its allowlist at startup and one line per request either way —
`egress: allow`, with the rule and route that carried it, or `egress: deny`
with what was asked for and why it was refused.

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
  "upstream_socket": "/run/user/1001/thicket/bridge.sock",
  "egress_allow": [
    "thicket-hearth.tailXXXX.ts.net",
    "slack.com",
    "*.slack.com"
  ]
}
```

The bridge is the account with the most to reach and the most to lose: it
holds every agent's Slack tokens, and its way out is this socket alone. Every
agent it serves belongs in `egress_allow`, and so does Slack — twice, because
`*.slack.com` deliberately does not admit `slack.com` itself. The wildcard is
not laziness: the file and WebSocket hosts Slack hands out at run time are
Slack's to choose, and an allowlist that named today's would fail on the day
they changed.

Nothing else is reachable, and there is no fallback: with no egress socket the
bridge refuses to start and says which path it looked at. `egress_socket` in
`bridge.json` overrides the default (`$XDG_RUNTIME_DIR/thicket/netd-egress.sock`),
which is netd's own default in the same account and rarely needs saying.

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
uploaded to its own threads, and no token is minted or distributed. The same
`thicket-netd.service` file serves both roles: it orders itself against nothing
but the network, so the absence of an agentd in this account is not a missing
dependency.

### The phone bridge's netd faces the internet

The phone bridge is the one component the public internet reaches: Twilio
dials its WebSocket. That edge is a mode of the same netd, not a new
component — a Tailscale Funnel listener on port 443 in front of the
bridge's socket — so the account keeps the shape of every other: one
binary, one config, one auth key. In `~/.config/thicket/netd.json`:

```json
{
  "hostname": "thicket-phone",
  "tag": "tag:thicket-phone",
  "upstream_socket": "/run/user/1002/thicket/agentd.sock",
  "funnel": {
    "path_prefix": "/",
    "upstream_socket": "/run/user/1002/thicket/phone.sock"
  }
}
```

The public handler forwards only `path_prefix`, strips every `X-Thicket-*`
header, and stamps **nothing** — an internet caller has no tags, and the
bridge authenticates Twilio by its signature. The tailnet side of port 443
is untouched: peers on the tailnet still reach the inbound proxy with their
WhoIs-verified tags, and only connections Tailscale relays in from the
internet reach the public handler (`FunnelOnly`). The upstream may not be
agentd's socket; netd refuses that at start.

Funnel is a tailnet permission, not a node setting. Two things must be
true before netd will start with the section present, and it says which is
missing:

- **HTTPS certificates** are enabled for the tailnet (DNS → HTTPS
  Certificates), so the node has a cert domain to serve on.
- The phone tag carries the **`funnel` node attribute** in the tailnet
  policy:

  ```json
  "nodeAttrs": [
    { "target": ["tag:thicket-phone"], "attr": ["funnel"] }
  ]
  ```

The public hostname is then `https://thicket-phone.<tailnet>.ts.net`; it is
what the bridge's `phone.json` names as `public_base_url`, and what the
number's voice URL points at. Scanners find it within seconds of it
appearing; the bridge answers them with 404 and never reads a body it did
not sign for.

`provision` renders this account once any agent has `phone.enabled`:
`rendered/phone/agents.yaml` and the `netd.json` above (the Funnel upstream
defaults to the bridge's socket), and `tag:thicket-phone` joins
`allowed_peer_tags` in the `agentd.json` of every agent that opted in — and
no other. The secrets half, `phone.json`, is the operator's and is never
rendered.

### The number is pointed at the bridge by `provision`, not by hand

A voice URL set in the Twilio Console is a generator bug: nobody remembers
it after a redeploy. Give `provision` the operator's Twilio file instead,
`~/.config/thicket/twilio.json`, mode 0600, beside the Slack configuration
token:

```json
{
  "account_sid": "AC...",
  "api_key_sid": "SK...",
  "api_key_secret": "...",
  "number": "+1...",
  "public_base_url": "https://thicket-phone.tailXXXX.ts.net"
}
```

A restricted API key needs `active-numbers` read and update; the account's
auth token works instead of the pair. With the file present, `provision`
sets the number's voice URL to `<public_base_url>/voice` (POST) and its
status callback to `/status`, idempotently — `--dry-run` prints exactly
which fields would change and touches nothing. `doctor` compares the live
settings to the rendered ones and fails with the drift when someone has
pointed the number elsewhere.

## 6b. The phone bridge's account

The phone bridge is deployed exactly like the Slack bridge: its own unix
account on the always-on host, its own netd — this one with the Funnel
listener — the same units, and secrets as 0600 files the operator writes.
Steps 1–3 above apply verbatim with `thicket-phone` as the account and
`tag:thicket-phone` as the tag on its auth key. Then, as that account:

```sh
# binaries: netd and the phone bridge
install -m 0755 thicket-netd thicket-phone ~/.local/bin/

# the roster-derived half, rendered by `provision` on the operator's machine
cp rendered/phone/agents.yaml rendered/phone/netd.json ~/.config/thicket/
install -m 0600 /dev/stdin ~/.config/thicket/tailnet-auth-key <<<'tskey-...'

# the secrets half: the operator writes it, provision never renders it
install -m 0600 /dev/stdin ~/.config/thicket/phone.json <<'EOF'
{
  "public_base_url": "https://thicket-phone.tailXXXX.ts.net",
  "twilio": { "account_sid": "AC...", "auth_token": "...", "api_key_sid": "SK...", "api_key_secret": "...", "number": "+1..." },
  "operator_numbers": ["+1..."],
  "pin": "12345678",
  "alerts": { "channel": "C...", "bot_token": "xoxb-..." }
}
EOF

cp deploy/systemd/thicket-netd.service deploy/systemd/thicket-phone.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now thicket-netd.service thicket-phone.service
```

`phone.json` refuses to load unless it is mode 0600 and names a PIN and an
allow-list; `twilio.auth_token` must be the account's **primary** auth
token, the only credential that validates Twilio's signature. The bridge
binds `$XDG_RUNTIME_DIR/thicket/phone.sock` and nothing else; netd's
Funnel listener is the only way in.

### The ACL edge, drawn deliberately

Two lines in the tailnet policy say who may reach whom, and both are
deliberate:

- **The phone bridge's tag may call every phone-enabled agent — privileged
  ones included.** `tag:thicket-phone` appears in the `dst` rule for an
  agent's node, and in that agent's `allowed_peer_tags`, exactly when the
  roster entry says `phone.enabled: true`; `provision` renders the second
  from the first. The caller behind that tag is the operator, authenticated
  by PIN, which is why root-holding agents may be on the list: the roster
  line is where they get there, reviewed like any other.
- **Nothing may call the bridge but Twilio, through Funnel.** No rule names
  `tag:thicket-phone` as a `dst`. The tailnet side of its port 443 is
  netd's ordinary inbound proxy pointed at a socket that does not exist in
  this account, so a tailnet peer that tries gets a 502 and nothing more;
  the internet side reaches the bridge, which authenticates every request
  by Twilio's signature and every caller by PIN.

```json
"acls": [
  {"action": "accept", "src": ["tag:thicket-bridge", "tag:thicket-phone"], "dst": ["tag:thicket-hearth:443"]},
  {"action": "accept", "src": ["tag:thicket-hearth"], "dst": ["tag:thicket-bridge:443"]}
],
"nodeAttrs": [
  {"target": ["tag:thicket-phone"], "attr": ["funnel"]}
]
```

Adding an agent to the phone means adding its tag to the first rule's
`dst` and flipping `phone.enabled` in the roster; nothing else.

## 7. Verify

```sh
systemctl --user status thicket-netd thicket-agentd   # as the account
thicket doctor                                        # as the operator
```

`doctor` checks the roster, each card, tailnet tags, Slack app state, the
workspace app cap, lingering, and — where there is a phone — every link of
the phone path: `phone.json` loads, the public hostname answers from the
bridge, the number points at it, the bridge's heartbeat is fresh. It exits
non-zero on any failure.

Useful spot checks:

```sh
# agentd owns its socket: stopped, the path answers nothing; started, it does
systemctl --user stop thicket-agentd.service
curl --unix-socket "$XDG_RUNTIME_DIR/thicket/agentd.sock" http://x/.well-known/agent-card.json
systemctl --user start thicket-agentd.service
curl --unix-socket "$XDG_RUNTIME_DIR/thicket/agentd.sock" http://x/.well-known/agent-card.json

# agentd restarts independently of netd
systemctl --user restart thicket-agentd.service  # netd untouched
```

## macOS

No systemd: use the launchd plists. `agentd` creates its own 0600 socket here
too — the two platforms now start it the same way.

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
