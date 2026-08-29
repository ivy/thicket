#!/bin/sh
# The Go half of `pnpm lint`. Run from the repo root.
#
# gofmt reports unformatted files on stdout and still exits 0, so the check is
# the emptiness of that list, not the exit code. The list names the file; the
# diff says what is wrong with it, which is the part worth reading.
set -eu

unformatted=$(gofmt -l netd)
if [ -n "$unformatted" ]; then
  echo "$unformatted" >&2
  gofmt -d netd >&2
  exit 1
fi

go vet ./netd/...
