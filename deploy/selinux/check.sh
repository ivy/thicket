#!/bin/sh
# Static checks for the policy module. Run from the repo root by pnpm lint.
# Verifies what a machine without SELinux can verify: that the module says
# what the units and the install layout assume, and that the one property
# the whole thing exists for has not quietly been given away.
set -eu

fail=0
err() {
  echo "FAIL: $*" >&2
  fail=1
}

dir=$(dirname "$0")
te="$dir/thicket.te"
fc="$dir/thicket.fc"
units="$dir/../systemd/system"

# --- the asymmetry, which is the whole design -----------------------------
# netd holds the network permissions because it is the only process in these
# accounts that may reach one. The two JavaScript domains must hold none: a
# dependency that decides to phone home should be denied at the socket class,
# not at a destination list it might find a hole in.
for domain in thicket_bridge_t thicket_phone_t; do
  if grep -nE "^allow[^;]*\\b$domain\\b[^;]*:[^;]*\\b(tcp_socket|udp_socket|rawip_socket|packet_socket)\\b" "$te"; then
    err "$domain has been granted a network socket class; that is the property this module exists for"
  fi
done
grep -qE "^allow thicket_netd_t self : tcp_socket" "$te" ||
  err "thicket_netd_t cannot open a tcp socket; it is the one domain that must"

# --- layout drift ---------------------------------------------------------
# The .fc labels paths the units name. If one moves without the other, the
# domains are never entered and the failure looks like a missing binary.
for path in /etc/thicket /var/lib/thicket /run/thicket; do
  grep -q "^$path" "$fc" || err "$fc does not label $path"
done
for exe in netd bridge phone; do
  grep -q "/opt/thicket/\[^/\]+/bin/thicket-$exe" "$fc" ||
    err "$fc does not label the thicket-$exe executable"
done
# Every directory the system units name must be one the module labels.
for unit in "$units"/*.service; do
  for var in XDG_CONFIG_HOME=/etc XDG_STATE_HOME=/var/lib XDG_RUNTIME_DIR=/run; do
    grep -q "$var" "$unit" ||
      err "$(basename "$unit"): $var does not match the paths thicket.fc labels"
  done
  grep -q 'ExecStart=/usr/local/bin/' "$unit" ||
    err "$(basename "$unit"): ExecStart is not the /usr/local/bin symlink the install makes"
done

# --- it compiles ----------------------------------------------------------
if command -v checkmodule >/dev/null 2>&1; then
  # checkmodule insists the output basename match the module name, so it
  # cannot be pointed at /dev/null.
  out=$(mktemp -d)
  checkmodule -M -m -o "$out/thicket.mod" "$te" >/dev/null ||
    err "the policy module does not compile"
  rm -rf "$out"
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "selinux policy OK"
