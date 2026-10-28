#!/usr/bin/env bash
# Runs the adapter's unit tests and the parity suite. Inside WSL or Linux, from anywhere:
#
#   bash jupiter-adapter/test.sh                          offline, against the committed fixtures
#   RPC=http://127.0.0.1:8899 bash jupiter-adapter/test.sh    snapshot missing fixtures from a cluster
#   RPC=<url> REFRESH=1 bash jupiter-adapter/test.sh      snapshot all fixtures again
#   FRESH_PROGRAMS=1 bash jupiter-adapter/test.sh         copy the programs from the last build first
#
# The programs the suite executes live in tests/fixtures/*.so. They are copies of the build
# output of the workspace next door. FRESH_PROGRAMS=1 refreshes them after a program change;
# without it the committed copies are used, so the suite runs on a machine with no build.
#
#   PROGRAMMABLE_DEPLOY_DIR   where FRESH_PROGRAMS finds the built programs. Default: the
#                         workspace's build output, $HOME/targets/sol-hooks/deploy.
#   CARGO_TARGET_DIR      where this crate is built. Default: $HOME/targets/programmable-jupiter.
set -euo pipefail
cd "$(dirname "$0")"
# The source may be in a synced folder; keep the build output on the Linux disk.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/targets/programmable-jupiter}"

DEPLOY="${PROGRAMMABLE_DEPLOY_DIR:-$HOME/targets/sol-hooks/deploy}"
mkdir -p tests/fixtures
copy() { # <built name> <fixture name>
  if [ -n "${FRESH_PROGRAMS:-}" ] || [ ! -f "tests/fixtures/$2.so" ]; then
    [ -f "$DEPLOY/$1.so" ] || { echo "missing $DEPLOY/$1.so: build the programs first (bash build.sh build)"; exit 1; }
    cp "$DEPLOY/$1.so" "tests/fixtures/$2.so"
  fi
}
# The kit loads the pool program by the adapter's label, lowercased: "Programmable".
copy hookpool programmable
copy hook_tax hook_tax
copy hook_launch_guard hook_launch_guard
copy hook_buyback hook_buyback
copy hook_collectible hook_collectible
copy hook_rules hook_rules

# Two tests read the fixtures of the same pool. While fixtures are being written, run the
# tests one at a time so that neither reads a folder the other is replacing.
if [ -n "${REFRESH:-}" ]; then export RUST_TEST_THREADS=1; fi

cargo test "$@"
