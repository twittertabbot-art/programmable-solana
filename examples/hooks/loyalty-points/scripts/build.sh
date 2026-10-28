#!/usr/bin/env bash
# Build this hook. It runs the hook kit's own script (hook-template/scripts/build.sh)
# on this folder; read that file for what it does and where the output goes.
#   bash scripts/build.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK_DIR="$HERE/.." exec bash "$HERE/../../../../hook-template/scripts/build.sh" "$@"
