#!/usr/bin/env bash
# Test this hook against the REAL pool program, in process. No validator, no deploy,
# nothing frozen. Run inside Linux or WSL, from anywhere:
#   bash scripts/test.sh [arguments for cargo test, for example a test name]
#
# It builds the hook first, so the tests never run against a stale binary, and then
# runs the tests in tests/. They load the pool from the Programmable repository's own build:
# run `bash build.sh build` at the repository root once before the first run.
#
# Environment:
#   HOOK_TEST_TARGET_DIR   where the test build goes. Default ~/targets/programmable-hook-tests,
#                          shared by every hook project on this machine so the pool
#                          programs and the harness are compiled once (about 2 GB).
#   HOOK_DIR, PROGRAM, HOOK_TARGET_DIR, SOLANA_BIN   see scripts/env.sh
set -euo pipefail
source "$(dirname "$0")/env.sh"

[ -f tests/Cargo.toml ] || fail "this project has no tests/ folder"
# The harness loads the pool's binaries from the repository it lives in. Say so here
# when they are missing, instead of failing inside the first test.
HARNESS="$(sed -n 's/^hookpool-tests *= *{ *path *= *"\([^"]*\)".*/\1/p' tests/Cargo.toml | head -n 1)"
if [ -n "$HARNESS" ]; then
  case "$HARNESS" in /*) ;; *) HARNESS="tests/$HARNESS" ;; esac
  [ -f "$HARNESS/Cargo.toml" ] || fail "the test harness is not at $HARNESS (the hookpool-tests path in tests/Cargo.toml).
       It is the tests/ folder at the root of the Programmable repository."
  [ -f "$HARNESS/../target/deploy/hookpool.so" ] || fail "the pool program is not built yet. At the root of the Programmable repository run:
         bash build.sh build"
fi

build_hook
export HOOK_SO="$PROGRAM_SO"
export CARGO_TARGET_DIR="${HOOK_TEST_TARGET_DIR:-$HOME/targets/programmable-hook-tests}"
mkdir -p "$CARGO_TARGET_DIR"
cd tests
cargo test "$@"
