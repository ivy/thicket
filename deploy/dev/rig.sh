#!/usr/bin/env bash
# The local development rig: agentd, the bridge, and the three stand-ins
# that play netd where there is no tailnet. Development only — the
# stand-ins assert identities netd would verify.
#
#   ./deploy/dev/rig.sh start|stop|restart|status
#
# Restart after every build. A running process holds the old code, and a
# test against it is a test of the previous commit.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOME_DIR="${THICKET_TEST_HOME:-$HOME/thicket-test}"

# Resolve the toolchain before XDG_* is redirected below. mise keeps its
# trust records under XDG_STATE_HOME, so a relocated one makes every
# `mise exec` reject the operator's global config ("not trusted") and the
# whole rig dies before a single process binds.
BUN="${THICKET_BUN:-$(mise which bun)}"

# The rig runs the artifacts an agent account would install, not a checkout,
# so a live check measures what ships. `mise exec -- pnpm compile` refreshes
# them; only the netd stand-ins stay scripts, because netd is not one of them.
host_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=macos ;;
    Linux) os=linux ;;
    *) echo "unsupported platform $(uname -s)" >&2; exit 2 ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) echo "unsupported architecture $(uname -m)" >&2; exit 2 ;;
  esac
  echo "$os-$arch"
}
BIN_DIR="${THICKET_BIN_DIR:-$REPO/dist-bin/$(host_platform)}"

export XDG_CONFIG_HOME="$HOME_DIR/config"
export XDG_STATE_HOME="$HOME_DIR/state"
export XDG_RUNTIME_DIR="$HOME_DIR/run"
export XDG_CACHE_HOME="$HOME_DIR/cache"

SOCKETS="$XDG_RUNTIME_DIR/thicket"
AGENTD_PORT=8791   # bridge -> agentd, carrying the bridge's tag
BRIDGE_PORT=8792   # agent -> bridge file surface, carrying the agent's tag
PHONE_PORT=8793    # Twilio -> phone bridge, through Tailscale Funnel

# Funnel is the phone bridge's public ingress on the laptop, the shape netd
# takes in M3. The App Store client keeps the CLI inside the bundle.
TAILSCALE="${THICKET_TAILSCALE:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}"
[[ -x "$TAILSCALE" ]] || TAILSCALE="$(command -v tailscale || true)"

# The agent this rig fronts. The stand-ins assert its tag and the bridge is
# told where to reach it, so both must name the same agent as the roster —
# a mismatch looks like Slack silently never delivering.
AGENT="${THICKET_DEV_AGENT:-$(sed -n 's/^  \([a-z0-9][a-z0-9-]*\):$/\1/p' \
  "$XDG_CONFIG_HOME/thicket/agents.yaml" 2>/dev/null | head -1)}"

pidfile() { echo "$HOME_DIR/$1.pid"; }
logfile() { echo "$HOME_DIR/$1.log"; }

running() {
  local pid
  pid="$(cat "$(pidfile "$1")" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# Launch detached, record the pid, and append to the process's own log.
spawn() {
  local name="$1"; shift
  nohup "$@" >>"$(logfile "$name")" 2>&1 &
  echo $! >"$(pidfile "$name")"
}

start_one() {
  local name="$1"; shift
  if running "$name"; then
    echo "$name already running ($(cat "$(pidfile "$name")"))"
    return
  fi
  spawn "$name" "$@"
  echo "$name started ($(cat "$(pidfile "$name")"))"
}

start() {
  if [[ -z "$AGENT" ]]; then
    echo "no agent in $XDG_CONFIG_HOME/thicket/agents.yaml; set THICKET_DEV_AGENT" >&2
    exit 2
  fi
  local name
  for name in thicket-agentd thicket-bridge thicket-phone; do
    if [[ ! -x "$BIN_DIR/$name" ]]; then
      echo "no $BIN_DIR/$name — run: mise exec -- pnpm compile" >&2
      exit 2
    fi
  done
  mkdir -p "$SOCKETS" "$HOME_DIR"

  # netd stand-ins first: the bridge dials the agent through one of them.
  UPSTREAM="$SOCKETS/agentd.sock" PEER_TAG=tag:thicket-bridge PORT="$AGENTD_PORT" \
    start_one proxy "$BUN" "$REPO/deploy/dev/peer-tag-proxy.mjs"
  UPSTREAM="$SOCKETS/bridge.sock" PEER_TAG="tag:thicket-$AGENT" PORT="$BRIDGE_PORT" \
    start_one bridge-proxy "$BUN" "$REPO/deploy/dev/peer-tag-proxy.mjs"
  SOCKET="$SOCKETS/netd-egress.sock" \
    start_one egress "$BUN" "$REPO/deploy/dev/egress-proxy.mjs"

  start_one agentd "$BIN_DIR/thicket-agentd"
  THICKET_BRIDGE_ENDPOINTS="{\"$AGENT\":\"http://127.0.0.1:$AGENTD_PORT\"}" \
    start_one bridge "$BIN_DIR/thicket-bridge"

  # The phone bridge reads $XDG_CONFIG_HOME/thicket/phone.json (0600) and
  # dials the agent through the same stand-in the Slack bridge uses.
  if [[ -f "$XDG_CONFIG_HOME/thicket/phone.json" ]]; then
    THICKET_PHONE_ENDPOINTS="{\"$AGENT\":\"http://127.0.0.1:$AGENTD_PORT\"}" \
      start_one phone "$BIN_DIR/thicket-phone"
    funnel_on
  else
    echo "phone not started: no $XDG_CONFIG_HOME/thicket/phone.json (see docs/live-testing.md)"
  fi
}

funnel_on() {
  if [[ -z "$TAILSCALE" ]]; then
    echo "funnel not started: no tailscale CLI"
    return
  fi
  if "$TAILSCALE" funnel status 2>/dev/null | grep -q "127.0.0.1:$PHONE_PORT"; then
    echo "funnel already on"
    return
  fi
  # --bg returns once the tailnet accepts the config; the hostname is public
  # from then on, and scanners find it within seconds.
  if "$TAILSCALE" funnel --bg "$PHONE_PORT" >/dev/null 2>&1; then
    echo "funnel on ($(funnel_host))"
  else
    echo "funnel FAILED: run '$TAILSCALE funnel --bg $PHONE_PORT' by hand to see why" >&2
  fi
}

funnel_off() {
  [[ -n "$TAILSCALE" ]] || return 0
  if "$TAILSCALE" funnel status 2>/dev/null | grep -q "127.0.0.1:$PHONE_PORT"; then
    "$TAILSCALE" funnel --https=443 off >/dev/null 2>&1 && echo "funnel off"
  fi
}

# The MagicDNS name Funnel serves, e.g. host.tailnet.ts.net.
funnel_host() {
  "$TAILSCALE" status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1
}

stop() {
  local name pid
  funnel_off
  for name in phone bridge agentd egress bridge-proxy proxy; do
    pid="$(cat "$(pidfile "$name")" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      echo "$name stopped ($pid)"
    fi
    rm -f "$(pidfile "$name")"
  done
  # The bridge unlinks its socket on a clean exit; a killed one may not.
  rm -f "$SOCKETS/bridge.sock"
}

status() {
  local name pid ok=0
  for name in agentd bridge phone proxy bridge-proxy egress; do
    pid="$(cat "$(pidfile "$name")" 2>/dev/null || true)"
    if running "$name"; then
      printf '%-14s up    %s\n' "$name" "$pid"
    else
      printf '%-14s DOWN\n' "$name"
      ok=1
    fi
  done
  # Liveness, not just presence: a process can be up and not serving.
  if curl -fsS --unix-socket "$SOCKETS/agentd.sock" \
      http://x/.well-known/agent-card.json >/dev/null 2>&1; then
    printf '%-14s ok\n' "agent card"
  else
    printf '%-14s UNREACHABLE\n' "agent card"
    ok=1
  fi
  # The phone bridge answers 404 to a bare GET; anything else is Funnel or
  # nothing talking. Checked locally, then through the public hostname —
  # the second is the one Twilio's connect depends on.
  local host code
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PHONE_PORT/" 2>/dev/null || true)"
  if [[ "$code" == 404 ]]; then
    printf '%-14s ok    127.0.0.1:%s\n' "phone" "$PHONE_PORT"
  else
    printf '%-14s UNREACHABLE (local http %s)\n' "phone" "${code:-none}"
    ok=1
  fi
  if [[ -n "$TAILSCALE" ]] && "$TAILSCALE" funnel status 2>/dev/null | grep -q "127.0.0.1:$PHONE_PORT"; then
    host="$(funnel_host)"
    code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "https://$host/" 2>/dev/null || true)"
    if [[ "$code" == 404 ]]; then
      printf '%-14s ok    https://%s\n' "funnel" "$host"
    else
      printf '%-14s NOT ANSWERING https://%s (http %s)\n' "funnel" "$host" "${code:-none}"
      ok=1
    fi
  else
    printf '%-14s off\n' "funnel"
  fi
  return "$ok"
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 2; start ;;
  status) status ;;
  *) echo "usage: $0 start|stop|restart|status" >&2; exit 2 ;;
esac
