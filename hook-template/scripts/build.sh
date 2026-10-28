#!/usr/bin/env bash
# Build this hook as an SBPF v0 program. Run inside Linux or WSL, from anywhere:
#   bash scripts/build.sh
#
# The first run creates the program keypair, and with it the program id. Every run
# writes that id into src/lib.rs (declare_id!) and Anchor.toml before compiling.
# Output: the build folder printed at the end (see scripts/env.sh for where and why).
set -euo pipefail
source "$(dirname "$0")/env.sh"

build_hook
echo
echo "program    : $PROGRAM"
echo "program id : $PROGRAM_ID"
echo "binary     : $PROGRAM_SO ($(stat -c %s "$PROGRAM_SO") bytes)"
echo "idl        : $HOOK_OUT/idl/$PROGRAM.json"
