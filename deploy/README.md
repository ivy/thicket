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

## 3. Give the account a tailnet credential (operator)

Two forms work, and they differ in one way that matters: whether they expire.

**An OAuth client secret, for a fleet.** In the admin console create an OAuth
client with the `auth_keys` scope, owning the tags the fleet uses. Its secret
does not expire; netd resolves it through the OAuth2 client-credentials flow
and mints a fresh short-lived key at every start, using the tag the node
already advertises. Nothing to rotate, nothing to propagate, nothing to
restart.

```sh
sudo -u hearth mkdir -p ~hearth/.config/thicket
sudo -u hearth sh -c 'umask 077; cat > ~/.config/thicket/tailnet-auth-key'
# tskey-client-xxxx?ephemeral=false&preauthorized=true   ^D
```

`ephemeral=false` is the part to get right. An ephemeral node is
garbage-collected the moment it goes offline, which for an always-on agent
means an ACL edge that disappears rather than a node that reconnects.

One client per tag rather than one for the fleet, if the accounts differ in
how exposed they are: a secret that can register any tag lets a compromised
account come up as another one, while per tag a leak is worth exactly the
node it already was.

**A tagged auth key, for one account or a rig.** In the admin console create
a key **tagged** with this agent's tag, e.g. `tag:thicket-hearth` — the key
must own the tag or netd refuses to start — reusable or single-use per your
rotation policy. It is one paste, and it dies within ninety days: that is the
maximum Tailscale allows, and there is no such thing as an auth key that does
not expire.

That expiry is worth stating plainly because of how it fails. A node already
running is unaffected, so nothing looks wrong until something restarts — and
then registration is refused at start:

```
netd: joining tailnet: invalid key: unauthorized
```

A fleet installed on keys stops being able to re-register one account at a
time, on a schedule nobody wrote down. The client secret has no such day.

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

### One account, or two

By default netd's sockets are 0600: netd and the process it fronts are the
same unix user, and nobody else on the host can reach either. `socket_group`
in `netd.json` widens them to 0660 and that group instead, which is what lets
the two run as **different** users.

That is worth doing where a kernel-level backstop sits behind the unit
sandboxing. A firewall rule can drop outbound traffic by uid — but only if
the process that must not have network and the process that must are
different uids. Sharing one, the rule has to permit everything netd needs,
which is everything a compromised client would want. Matching on cgroup
instead does not survive a restart: the path is resolved to an id when the
rule loads, and a restarted unit gets a new one.

So: netd as its own user with the network, the process it fronts as another
with none, both in a group that owns the socket between them.

The two halves are one decision. `socket_group` in `bridge.json` and in
`phone.json` does the same for the socket netd proxies *to* — the file
surface agents fetch uploaded files from, and the phone bridge's own
listener. Split the accounts with only netd's option set and netd can no
longer reach the runtime; set neither and both stay 0600, which is what a
single-account deployment wants.

### Two pairs on one host

A pair is a runtime and the netd beside it. Both edge components on one host
is two pairs, and they have to stay apart:

- **A group is exactly one pair.** Each runtime's own primary group is the
  pair's, and its netd carries that group as a supplementary — so the members
  are the two accounts and nothing else. Put both pairs in one group and
  either runtime can open the other's egress socket, and reach everything on
  the other's allowlist: the Slack bridge's netd may reach Slack, the phone
  bridge's may reach a short list of agents, and sharing the group hands each
  of them the other's permissions.
- **A runtime directory is exactly one pair.** Every pair names its sockets
  the same way, so two pairs in `/run/thicket` collide on
  `netd-egress.sock`: whichever netd starts second replaces the first's, and
  the directory's owner flips between the two netd accounts on every restart.
  The first pair on a host can take the defaults; a second one gets its own
  directory and names the paths, because the defaults are derived from
  `XDG_RUNTIME_DIR` and both units pin that at `/run`.

- **A config file is exactly one pair.** Both netds read
  `$XDG_CONFIG_HOME/thicket/netd.json` by default, and both units pin that
  variable at `/etc`, so without `--config` the second pair to start reads the
  first one's hostname, tag, allowlist and credential. The shipped units name
  their own — `bridge-netd.json` and `phone-netd.json` — and each names its own
  tailnet credential inside it, because one key mints for one tag.

The shipped units put the phone bridge's pair in `/run/thicket-phone`, so its
config names what lives there:

```json
// /etc/thicket/phone-netd.json — the phone bridge's netd
{
  "hostname": "thicket-phone",
  "tag": "tag:thicket-phone",
  "auth_key_file": "/etc/thicket/phone-tailnet-auth-key",
  "state_dir": "/var/lib/thicket-phone-netd/tsnet",
  "egress_socket": "/run/thicket-phone/netd-egress.sock",
  "socket_group": "thicket-phone",
  "egress_allow": ["thicket-hearth.tailXXXX.ts.net", "slack.com"],
  "funnel": { "path_prefix": "/", "upstream_socket": "/run/thicket-phone/phone.sock" }
}
```

```json
// /etc/thicket/phone.json — root's alone, handed over as a credential
{
  "socket_path": "/run/thicket-phone/phone.sock",
  "socket_group": "thicket-phone",
  "egress_socket": "/run/thicket-phone/netd-egress.sock"
}
```

`/var/lib/thicket` is the shared parent of both runtimes' state, so it has to
be traversable by both — root-owned and `0755`. Each component's own
subdirectory below it is systemd's, created from `StateDirectory=`.

## The edge is not an agent

The Slack bridge and the phone bridge are not agents and should not be
deployed like them. An agent is a `(host, unix user)` pair with a home it
manages, and there are as many as the roster says. There is exactly one of
each bridge per fleet, their config belongs to the operator, and they run no
sessions at all.

Deployed as user units they would inherit the agent model's weakest step —
lingering, the single most common way a user-unit deployment silently fails —
and none of the containment a system unit can carry. So they are system
units, in `deploy/systemd/system/`, and nothing about them needs lingering.

Both runtimes already read the XDG variables, so this costs no code. Pinning
them lines the paths up with the directories systemd creates and owns:

| Variable | Value | systemd directive | Holds |
|---|---|---|---|
| `XDG_CONFIG_HOME` | `/etc` | `ConfigurationDirectory=thicket` | what the operator writes |
| `XDG_STATE_HOME` | `/var/lib` | `StateDirectory=thicket/<component>` | what the process keeps |
| `XDG_RUNTIME_DIR` | `/run` | `RuntimeDirectory=thicket[-<pair>]` | the sockets the pair meet on |

Config is shared — one `/etc/thicket`, one roster, one file per component —
and everything written at run time is not. Each runtime declares only its own
subdirectory of `/var/lib/thicket`, which is where it already writes; a unit
that declared the parent would take ownership of the sibling's state with it.

**Secrets arrive as credentials.** `LoadCredential=` hands the process a copy
that exists only while it runs, so the file on disk can be root's alone and
the service account cannot read that path at all — stronger than making it
unwritable.

**The runtime has no network.** `PrivateNetwork=yes`: no interface, no route,
no resolver. netd's socket beside it is not the preferred way out, it is the
only one. That is honest only because every leg is routed — for the bridge,
A2A, the Slack Web API and the Socket Mode websocket, which is why the bridge
speaks that protocol itself rather than through a library that cannot be
told where to go.

`systemd-analyze security` scores the shipped files 0.8 for each runtime and
4.1 for each netd, which has the network on purpose. `deploy/check.sh` fails
if a runtime drifts above 1.5.

Three things are off deliberately, each with the reason in the unit:

- **`MemoryDenyWriteExecute`** — Bun compiles as it runs and dies on its
  first turn without a writable-executable mapping.
- **`PrivateTmp`** — the two units meet on a socket under `/run`, and a
  private namespace is one step from a rendezvous that silently does not
  happen.
- **`PrivateUsers`** — it maps away every uid but the service's own, and the
  runtime has to hand its socket to the group netd reaches it through.

### And confined by SELinux

On a Fedora targeted-policy host, a service with no policy of its own runs
`unconfined_service_t`: SELinux is enforcing and doing nothing for it. The
module in `deploy/selinux/` gives the edge three domains — `thicket_netd_t`,
`thicket_bridge_t`, `thicket_phone_t` — and the asymmetry between them is
the design. netd holds the network permissions because it is the only
process in these accounts that may reach a network; the two runtimes hold
none, so a dependency that decides to phone home is denied at the socket
class rather than at a destination list it might find a hole in.

```sh
cd deploy/selinux
make                 # builds thicket.pp with checkpolicy alone
sudo make install    # installs it and labels what is already on disk
```

The module is written in the base policy language rather than against
refpolicy interfaces, so it builds on a host with no policy headers, and
what it grants can be read in one file instead of chased through m4.

**Bring it up permissive.** `sudo make permissive` puts the three domains in
permissive mode; run real traffic through them, read the AVCs
(`ausearch -m avc -ts recent`), fold what they turn up into `thicket.te`,
and only then `sudo make enforce`. That is not ceremony — the module as
shipped exists because a soak produced things no amount of reading the
source would have listed. Two worth knowing:

- **The runtimes need the CA store**, though they have no network. netd is a
  blind tunnel: it moves bytes it cannot read, so TLS to Slack or Twilio is
  terminated by the runtime at this end.
- **systemd needs its own permissions** on the labelled directories. It
  creates and bind-mounts them as `init_t`, which is never permissive, so a
  module that labels these paths and forgets that stops the unit at
  `226/NAMESPACE` before its domain is ever entered — and with
  `NoNewPrivileges=yes` set, the transition itself needs `nnp_transition` or
  the exec fails `203/EXEC`, which reads like a missing binary.

**Ask the kernel, not the source.** The module's own check refuses a JavaScript
domain that is granted a network socket class, but that reads the file in this
repository. What is loaded on a host is a separate question, and one command
answers it exhaustively — every rule, not the one a probe happened to try:

```sh
sudo sesearch -A -s thicket_bridge_t -c tcp_socket -p create,connect   # expect: nothing
sudo sesearch -A -s thicket_phone_t  -c tcp_socket -p create,connect   # expect: nothing
sudo sesearch -A -s thicket_netd_t   -c tcp_socket -p create,connect   # expect: one rule
```

`sesearch` is in `setools-console`. The netd rule is the whole design in one
line: it may open a TCP socket, and the two runtimes beside it may not.

Agent accounts stay unconfined. Their sessions have to do real work, and
confining them is a different problem.

Edge components are **Linux-only** by policy. launchd has no equivalent for
any of the above worth trusting, and the containment is the point of the
account.

### The bridge's netd faces inward too

The bridge's netd was already there for egress. Attachments also need the
reverse: an agent fetches the bytes of a file a human uploaded, because the
bot token that redeems Slack's private URL lives only in the bridge. So this
netd's upstream is the bridge itself rather than an agentd that does not exist
in this account.

`render` writes that file — `rendered/bridge/netd.json`, beside the agents'
and the phone's. Install it as `/etc/thicket/bridge-netd.json`, named for its
pair because the phone bridge's netd keeps its own config in the same
directory, and add what belongs to the deployment rather than the roster: the
credential's path, the group the pair meet in, and a state directory of its
own. What is rendered:

```json
{
  "hostname": "thicket-bridge",
  "tag": "tag:thicket-bridge",
  "auth_key_file": "tailnet-auth-key",
  "upstream_socket": "bridge",
  "egress_allow": [
    "thicket-hearth.tailXXXX.ts.net",
    "slack.com",
    "*.slack.com"
  ]
}
```

`upstream_socket` is a **name**, not a path: netd resolves a bare name under
its own runtime directory, so one rendered file is right in a user-unit
account whose runtime directory is `/run/user/<uid>/thicket` and in a system
unit whose is `/run/thicket`. A deployment that puts a pair somewhere of its
own — a second pair on one host — writes a path instead, and netd takes it as
written.

The bridge is the account with the most to reach and the most to lose: it
holds every agent's Slack tokens, and its way out is this socket alone —
including its Socket Mode websockets, which is why the bridge speaks that
protocol itself rather than through a library that cannot be routed. Every
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
binary, one config, one auth key. In `/etc/thicket/phone-netd.json`:

```json
{
  "hostname": "thicket-phone",
  "tag": "tag:thicket-phone",
  "auth_key_file": "/etc/thicket/phone-tailnet-auth-key",
  "upstream_socket": "/run/thicket-phone/agentd.sock",
  "socket_group": "thicket-phone",
  "funnel": {
    "path_prefix": "/",
    "upstream_socket": "/run/thicket-phone/phone.sock"
  }
}
```

`upstream_socket` names a socket that does not exist in this account, and
deliberately: it is what the *tailnet* side of port 443 is pointed at, so a
peer that dials this node gets a 502 and nothing more. Only the internet
side, through Funnel, reaches the bridge.

Outbound is the same story as everywhere else: the phone bridge dials agents
and posts alerts through `egress_socket`, and refuses to start without it.
Its `egress_allow` is therefore the agents that answer the phone and
`slack.com`, which `render` writes whether or not `alerts` is configured:
nothing that reads the roster can see whether it is, because the channel and
the token are in the operator's own `phone.json`. A rule that waited for them
would arrive after the alert it was needed for.

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
appearing — a certificate is a public announcement — and what they meet is
netd's own budget, spent before the bridge learns the request happened:

```json
"funnel": {
  "path_prefix": "/",
  "rate_limit": { "requests_per_second": 5, "burst": 20 }
}
```

Those are the defaults and need no configuration. One bucket for the whole
listener, not one per caller: Tailscale relays a Funnel connection in from
its own fabric, so every request arrives from the same address whoever sent
it, and a per-source limit would be this same bucket wearing a disguise. A
call is a handful of requests and then one long-lived websocket, so the
default is generous for anything real. Refusals are summarised at most once
a minute — a scan that can fill the journal has taken away the one place an
operator would look.

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

The phone bridge is deployed exactly like the Slack bridge: an edge
component, so system units rather than an agent's user units — two accounts,
config in `/etc/thicket`, secrets handed over as credentials, and no
lingering to forget. Step 3 above applies verbatim with `tag:thicket-phone`
as the tag on its credential. As root:

```sh
# The pair. Neither has a shell, a home, or a password.
for u in thicket-phone thicket-phone-netd; do
  useradd --system --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin "$u"
done
# netd carries the runtime's group so it can reach the socket beside it.
usermod --append --groups thicket-phone thicket-phone-netd

# The roster-derived half, rendered by `provision` or `thicket render`, plus
# the deployment paths from "Two pairs on one host" above.
install -m 0644 -o root -g root rendered/phone/agents.yaml /etc/thicket/
install -m 0640 -o root -g thicket-phone-netd rendered/phone/netd.json \
  /etc/thicket/phone-netd.json
install -m 0640 -o root -g thicket-phone-netd /dev/stdin \
  /etc/thicket/phone-tailnet-auth-key <<<'tskey-client-xxxx?ephemeral=false&preauthorized=true'

# The secrets half: the operator writes it, nothing renders it. Root's
# alone — the account never reads this path, LoadCredential hands the
# process a copy that exists only while it runs.
install -m 0600 -o root -g root /dev/stdin /etc/thicket/phone.json <<'EOF'
{
  "public_base_url": "https://thicket-phone.tailXXXX.ts.net",
  "socket_path": "/run/thicket-phone/phone.sock",
  "socket_group": "thicket-phone",
  "egress_socket": "/run/thicket-phone/netd-egress.sock",
  "twilio": { "account_sid": "AC...", "auth_token": "...", "api_key_sid": "SK...", "api_key_secret": "...", "number": "+1..." },
  "operator_numbers": ["+1..."],
  "pin": "12345678",
  "alerts": { "channel": "C...", "bot_token": "xoxb-..." }
}
EOF

install -d -m 0755 -o root -g root /var/lib/thicket   # the shared parent
install -m 0644 deploy/systemd/system/thicket-phone*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now thicket-phone-netd.service thicket-phone.service
```

netd logs `funnel: serving / to …`; the bridge logs `phone bridge up` with
the socket and the group it handed it to.

`phone.json` refuses to load unless it is mode 0600 and names a PIN and an
allow-list; `twilio.auth_token` must be the account's **primary** auth
token, the only credential that validates Twilio's signature. The bridge
binds that one socket and nothing else — no port at all; netd's Funnel
listener is the only way in, and it can dial the socket because
`socket_group` handed it to the group the pair share.

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
