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

# --- portability: same file must work in every account ---------------------
if grep -nE '/home/|/Users/[a-z]' "$dir"/systemd/* "$dir"/launchd/*.plist; then
  err "hardcoded home directory found"
fi
if grep -nE '%i' "$dir"/systemd/*; then
  err "instance templates (%i) are not used in thicket units"
fi

# --- systemd invariants ----------------------------------------------------
# agentd creates its own socket: Bun will not listen on a descriptor it did
# not open, so there is no socket unit to hand it one.
if ls "$dir"/systemd/*.socket >/dev/null 2>&1; then
  err "a .socket unit is back; agentd cannot be socket-activated under Bun"
fi
if grep -nE 'thicket-agentd\.socket' "$dir"/systemd/*; then
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
if grep -nE '^(Requires|BindsTo|PartOf)=.*thicket-(netd|phone)' "$dir/systemd/thicket-phone.service" "$dir/systemd/thicket-netd.service"; then
  err "phone.service and netd.service must not hard-depend on each other"
fi
if grep -nE 'ListenStream|listen=|:[0-9]{4}' "$dir/systemd/thicket-phone.service"; then
  err "phone.service must not bind a port; netd's Funnel listener is the only way in"
fi

for unit in thicket-netd.service thicket-agentd.service thicket-bridge.service thicket-phone.service; do
  grep -q 'NoNewPrivileges=yes' "$dir/systemd/$unit" || err "$unit: NoNewPrivileges missing"
  grep -q 'ProtectSystem=strict' "$dir/systemd/$unit" || err "$unit: ProtectSystem missing"
  grep -q 'Restart=on-failure' "$dir/systemd/$unit" || err "$unit: Restart missing"
done

# systemd-analyze exists only on systemd hosts; use it when available.
# ExecStart points into ~/.local/bin, so on a machine where thicket is not
# installed verify reports that and nothing else — a fact about the host, not
# about the artifact this script checks. Drop those lines and judge the rest;
# verify prints a line for every problem it finds, so an empty remainder is a
# pass.
if command -v systemd-analyze >/dev/null 2>&1; then
  verdict=$(systemd-analyze verify --user "$dir"/systemd/*.service 2>&1 |
    grep -v 'Command .* is not executable: No such file or directory' || true)
  if [ -n "$verdict" ]; then
    echo "$verdict" >&2
    err "systemd-analyze verify failed"
  fi
fi

# --- launchd invariants ----------------------------------------------------
for plist in "$dir"/launchd/*.plist; do
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$plist" >/dev/null || err "$plist: not a valid plist"
  fi
  grep -q '<key>RunAtLoad</key>' "$plist" || err "$plist: RunAtLoad missing"
  grep -q '<key>KeepAlive</key>' "$plist" || err "$plist: KeepAlive missing"
done

if [ "$fail" -eq 0 ]; then
  echo "deploy artifacts OK"
fi
exit "$fail"
