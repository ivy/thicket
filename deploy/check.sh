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
grep -q 'ListenStream=%t/thicket/agentd.sock' "$dir/systemd/thicket-agentd.socket" ||
  err "agentd.socket must listen at %t/thicket/agentd.sock (socketPath convention)"
grep -q 'SocketMode=0600' "$dir/systemd/thicket-agentd.socket" ||
  err "agentd.socket must be mode 0600"
grep -q 'Requires=thicket-agentd.socket' "$dir/systemd/thicket-agentd.service" ||
  err "agentd.service must require its socket"
if grep -q '\[Install\]' "$dir/systemd/thicket-agentd.service"; then
  err "agentd.service must not have an [Install] section (socket-activated)"
fi
# netd and agentd restart independently: no hard dependency edge between
# the two services in either direction (the socket unit is the only link).
if grep -nE '^(Requires|BindsTo|PartOf)=.*thicket-agentd\.service' "$dir/systemd/thicket-netd.service"; then
  err "netd.service must not hard-depend on agentd.service"
fi
if grep -nE '^(Requires|BindsTo|PartOf)=.*thicket-netd' "$dir/systemd/thicket-agentd.service"; then
  err "agentd.service must not hard-depend on netd.service"
fi

for unit in thicket-netd.service thicket-agentd.service thicket-bridge.service; do
  grep -q 'NoNewPrivileges=yes' "$dir/systemd/$unit" || err "$unit: NoNewPrivileges missing"
  grep -q 'ProtectSystem=strict' "$dir/systemd/$unit" || err "$unit: ProtectSystem missing"
  grep -q 'Restart=on-failure' "$dir/systemd/$unit" || err "$unit: Restart missing"
done

# systemd-analyze exists only on systemd hosts; use it when available.
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify --user "$dir"/systemd/*.service || err "systemd-analyze verify failed"
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
