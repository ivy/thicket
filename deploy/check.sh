#!/bin/sh
# Static checks for the deployment artifacts. Run from the repo root.
# Verifies what a machine without systemd can verify: syntax, portability
# (no hardcoded homes or usernames), and the invariants the units rely on.
set -eu

fail=0
err() {
  echo "FAIL: $*" >&2
  fail=1
}

dir=$(dirname "$0")

# Two shapes, deliberately. Agent units are user units: one file per account,
# paths through specifiers, the unix user as the instance. Edge units are
# system units: exactly one of each per fleet, named accounts, and the
# containment a user unit cannot carry.
user_units="$dir/systemd/thicket-agentd.service $dir/systemd/thicket-netd.service"
system_units=$(ls "$dir"/systemd/system/*.service)

# --- portability: the same agent file must work in every account -----------
if grep -nE '/home/|/Users/[a-z]' $user_units "$dir"/launchd/*.plist; then
  err "hardcoded home directory found"
fi
if grep -nE '%i' $user_units $system_units; then
  err "instance templates (%i) are not used in thicket units"
fi
if grep -nE '^(User|Group)=' $user_units; then
  err "an agent unit names a user; the account it runs in is the instance"
fi

# --- systemd invariants ----------------------------------------------------
# agentd creates its own socket: Bun will not listen on a descriptor it did
# not open, so there is no socket unit to hand it one.
if ls "$dir"/systemd/*.socket "$dir"/systemd/system/*.socket >/dev/null 2>&1; then
  err "a .socket unit is back; agentd cannot be socket-activated under Bun"
fi
if grep -nE 'thicket-agentd\.socket' $user_units $system_units; then
  err "a unit still references thicket-agentd.socket"
fi
grep -q 'RuntimeDirectory=thicket' "$dir/systemd/thicket-agentd.service" ||
  err "agentd.service must own %t/thicket, where it creates its socket"
grep -q 'RuntimeDirectoryMode=0700' "$dir/systemd/thicket-agentd.service" ||
  err "agentd.service: the socket directory must be 0700"
grep -q '\[Install\]' "$dir/systemd/thicket-agentd.service" ||
  err "agentd.service must have an [Install] section; nothing else starts it"
# netd and agentd restart independently: no hard dependency edge between
# the two services in either direction.
if grep -nE '^(Requires|BindsTo|PartOf)=.*thicket-agentd\.service' "$dir/systemd/thicket-netd.service"; then
  err "netd.service must not hard-depend on agentd.service"
fi
if grep -nE '^(Requires|BindsTo|PartOf)=.*thicket-netd' "$dir/systemd/thicket-agentd.service"; then
  err "agentd.service must not hard-depend on netd.service"
fi

# The phone bridge and its netd restart independently too: netd's Funnel
# listener dials the bridge's socket per connection, and a bridge restart
# must not take the node's tailnet identity down with it.
if grep -nE '^(Requires|BindsTo|PartOf)=' "$dir"/systemd/system/thicket-phone.service "$dir"/systemd/system/thicket-phone-netd.service; then
  err "phone.service and its netd must not hard-depend on each other"
fi
if grep -nE 'ListenStream|listen=|:[0-9]{4}' "$dir"/systemd/system/thicket-phone.service; then
  err "phone.service must not bind a port; netd's Funnel listener is the only way in"
fi

for unit in $user_units $system_units; do
  grep -q 'NoNewPrivileges=yes' "$unit" || err "$unit: NoNewPrivileges missing"
  grep -q 'ProtectSystem=strict' "$unit" || err "$unit: ProtectSystem missing"
  grep -q 'Restart=on-failure' "$unit" || err "$unit: Restart missing"
done

# systemd-analyze exists only on systemd hosts; use it when available.
# ExecStart points into ~/.local/bin, so on a machine where thicket is not
# installed verify reports that and nothing else — a fact about the host, not
# about the artifact this script checks. Drop those lines and judge the rest;
# verify prints a line for every problem it finds, so an empty remainder is a
# pass.
if command -v systemd-analyze >/dev/null 2>&1; then
  # verify --user needs a user manager to talk to, which a build agent or a
  # detached shell does not have. Its absence is a fact about the host.
  if [ -d "${XDG_RUNTIME_DIR:-/nonexistent}" ]; then
    verdict=$(systemd-analyze verify --user $user_units 2>&1 |
      grep -v 'Command .* is not executable: No such file or directory' || true)
    if [ -n "$verdict" ]; then
      echo "$verdict" >&2
      err "systemd-analyze verify failed"
    fi
  else
    echo "note: XDG_RUNTIME_DIR is unset; skipping systemd-analyze verify --user"
  fi
  # System units are scored rather than verified: verify wants to resolve the
  # accounts and directories they name, which exist on the host that runs
  # them and not on the one that checks the tree. --offline reads the file.
  for unit in $system_units; do
    score=$(systemd-analyze security --offline=true "$unit" 2>/dev/null |
      sed -n 's/.*Overall exposure level for [^:]*: \([0-9.]*\).*/\1/p')
    [ -n "$score" ] || continue
    case "$(basename "$unit")" in
      thicket-bridge.service | thicket-phone.service)
        # No network at all; anything above this means a line went missing.
        limit=1.5 ;;
      *)
        # netd holds the network, which is most of its exposure.
        limit=5.0 ;;
    esac
    if [ "$(printf '%s\n%s\n' "$score" "$limit" | sort -g | head -1)" != "$score" ]; then
      err "$(basename "$unit"): systemd-analyze security scores $score, above $limit"
    fi
  done
fi

# --- launchd invariants ----------------------------------------------------
for plist in "$dir"/launchd/*.plist; do
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$plist" >/dev/null || err "$plist: not a valid plist"
  fi
  grep -q '<key>RunAtLoad</key>' "$plist" || err "$plist: RunAtLoad missing"
  grep -q '<key>KeepAlive</key>' "$plist" || err "$plist: KeepAlive missing"
done

# --- system-unit invariants ------------------------------------------------
for unit in $system_units; do
  grep -q '^User=' "$unit" || err "$unit: a system unit must name its account"
  grep -q 'XDG_CONFIG_HOME=/etc' "$unit" ||
    err "$unit: config must resolve to /etc, where ConfigurationDirectory puts it"
  grep -q 'XDG_STATE_HOME=/var/lib' "$unit" ||
    err "$unit: state must resolve to /var/lib"
  grep -q 'XDG_RUNTIME_DIR=/run' "$unit" ||
    err "$unit: the runtime dir must resolve to /run, where the pair meet"
  grep -q '^NoNewPrivileges=yes' "$unit" || err "$unit: NoNewPrivileges is not set"
  grep -q '^ProtectSystem=strict' "$unit" || err "$unit: ProtectSystem is not strict"
  grep -q '^CapabilityBoundingSet=$' "$unit" ||
    err "$unit: the capability bounding set must be empty"
  # Bun compiles as it runs; this flag kills the process on its first turn.
  if grep -nE '^MemoryDenyWriteExecute=yes' "$unit"; then
    err "$unit: MemoryDenyWriteExecute breaks the JIT — never set it"
  fi
done

# The two halves of a pair meet on a socket under /run. A private /tmp is one
# namespace away from a rendezvous that silently does not happen.
for unit in "$dir"/systemd/system/thicket-bridge.service "$dir"/systemd/system/thicket-phone.service; do
  grep -q '^PrivateTmp=no' "$unit" ||
    err "$unit: PrivateTmp must be explicitly off, with the reason"
  grep -q '^PrivateNetwork=yes' "$unit" ||
    err "$unit: the edge runtimes have no network of their own"
  grep -q '^LoadCredential=' "$unit" ||
    err "$unit: secrets arrive as a credential, not as a readable file"
done

if [ "$fail" -eq 0 ]; then
  echo "deploy artifacts OK"
fi
exit "$fail"
