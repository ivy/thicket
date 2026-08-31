#!/bin/sh
# The two supply-chain settings this repo relies on, asserted rather than
# assumed. Both are one line in a config file and both are silent when
# removed, which is the combination that makes a check worth having.
set -eu

fail=0
err() {
  echo "FAIL: $*" >&2
  fail=1
}

workspace=pnpm-workspace.yaml

# --- the age gate ----------------------------------------------------------
# A poisoned release is usually found and pulled within days. Waiting is the
# cheapest defence available against a bump picking one up.
age=$(sed -n 's/^minimumReleaseAge:[[:space:]]*\([0-9]*\).*/\1/p' "$workspace")
if [ -z "$age" ]; then
  err "$workspace has no minimumReleaseAge; a bump can pick up a release published minutes ago"
elif [ "$age" -lt 10080 ]; then
  err "minimumReleaseAge is $age minutes; a week (10080) is the floor this repo set"
fi

# --- dependency install scripts -------------------------------------------
# pnpm 10 refuses them by default, which is most of the value: an install
# script is arbitrary code from a package you have not run yet. An allowlist
# is sometimes unavoidable, so what this asks for is a reason beside each
# entry rather than an empty list forever.
if grep -q '^onlyBuiltDependencies:' "$workspace"; then
  in_list=0
  while IFS= read -r line; do
    case "$line" in
      onlyBuiltDependencies:*) in_list=1; continue ;;
    esac
    [ "$in_list" -eq 1 ] || continue
    case "$line" in
      # A list entry: must carry a trailing comment saying why.
      "  - "*)
        case "$line" in
          *"#"*) ;;
          *) err "onlyBuiltDependencies: ${line# } runs an install script with no reason given" ;;
        esac
        ;;
      "  #"*) ;;
      "") ;;
      *) in_list=0 ;;
    esac
  done < "$workspace"
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "supply chain OK"
