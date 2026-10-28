#!/usr/bin/env bash
# Build / test wrapper. Run from the repository root, in Linux, macOS or WSL:
#   bash build.sh [build|test|unit|clippy|fmt|idl]
# Rust build output goes outside the repository (~/targets/sol-hooks, or SOLHOOKS_TARGET_DIR),
# linked here as ./target, so a synced or shared source folder never carries gigabytes of it.
set -euo pipefail
cd "$(dirname "$0")"

source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"
# Always our own directory, never an inherited one: tests and deploys read ./target.
export CARGO_TARGET_DIR="${SOLHOOKS_TARGET_DIR:-$HOME/targets/sol-hooks}"
mkdir -p "$CARGO_TARGET_DIR"
# anchor expects ./target; point it at the WSL disk
if [ ! -L target ]; then rm -rf target; ln -s "$CARGO_TARGET_DIR" target; fi

cmd="${1:-build}"
shift || true
case "$cmd" in
  build)   # --ignore-keys: the program ids are the ones written in the source. Anchor makes
           # throwaway keypairs in the build folder and would otherwise tell you to run
           # "anchor keys sync", which overwrites the real ids with those. Never run it here;
           # scripts/rekey.mjs is the way to change the ids.
           anchor build --arch v0 --ignore-keys "$@"
           # the IDLs are kept in the repository for integrators (INTEGRATORS.md)
           mkdir -p idl
           for p in hookpool hooklaunch hook_tax hook_launch_guard hook_buyback hook_collectible hook_rules; do
             [ -f "target/idl/$p.json" ] && cp "target/idl/$p.json" "idl/$p.json"
           done ;;
  idl)     anchor idl build "$@" ;;
  test)    cargo test --workspace "$@" ;;
  unit)    cargo test --workspace --lib "$@" ;;
  clippy)  cargo clippy --workspace --all-targets "$@" ;;
  fmt)     cargo fmt --all ;;
  sh)      exec bash ;;
  *)       echo "unknown command: $cmd"; exit 1 ;;
esac
