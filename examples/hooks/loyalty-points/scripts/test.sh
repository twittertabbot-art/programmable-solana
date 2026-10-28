#!/usr/bin/env bash
# Test this hook against the real pool program, in process. It runs the hook kit's own
# script (hook-template/scripts/test.sh) on this folder.
#   bash scripts/test.sh [arguments for cargo test]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK_DIR="$HERE/.." exec bash "$HERE/../../../../hook-template/scripts/test.sh" "$@"
