#!/usr/bin/env bash
# Build, deploy, publish the manifest and FREEZE this hook. It runs the hook kit's own
# script (hook-template/scripts/deploy-freeze.sh) on this folder; read that file for
# the environment it takes (WALLET, HOOK_NAME, HOOK_URI and the pin of the descriptor,
# FREEZE) and what freezing means.
#   bash scripts/deploy-freeze.sh [localnet|devnet|mainnet]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK_DIR="$HERE/.." exec bash "$HERE/../../../../hook-template/scripts/deploy-freeze.sh" "$@"
