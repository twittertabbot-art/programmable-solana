#!/usr/bin/env bash
# Give the program its own name. Run it once, right after copying the template:
#   bash scripts/rename.sh fee_split
#
# It changes every place the program's name is written:
#   programs/<name>/                 the folder
#   programs/<name>/Cargo.toml       the package name and the library name
#   programs/<name>/src/lib.rs       `pub mod <name>` under #[program]
#   Anchor.toml                      the line under [programs.localnet]
#   tests/Cargo.toml                 the line that names the hook under test
# The names inside comments and the error enum (MyHookError) are left alone: rename those
# by hand if you care. A renamed program gets a new keypair, so a new program id, on its
# next build.
#
# HOOK_DIR=<folder> renames the program of another hook project (a copy of an example).
set -euo pipefail
cd "${HOOK_DIR:-$(dirname "$0")/..}"
[ -f Anchor.toml ] || { echo "error: no hook project here ($(pwd) has no Anchor.toml)"; exit 1; }

NEW="${1:-}"
if ! [[ "$NEW" =~ ^[a-z][a-z0-9_]*$ ]]; then
  echo "usage: bash scripts/rename.sh <new_name>"
  echo "The name is a Rust crate name: lower case letters, digits and _, starting with a letter."
  exit 1
fi
found=()
for d in programs/*/; do
  [ -f "${d}Cargo.toml" ] && found+=("$(basename "$d")")
done
[ "${#found[@]}" -eq 1 ] || { echo "error: expected exactly one program under programs/, found ${#found[@]}"; exit 1; }
OLD="${found[0]}"
[ "$OLD" != "$NEW" ] || { echo "the program is already called $NEW"; exit 0; }

mv "programs/$OLD" "programs/$NEW"
sed -i "s/^name = \"$OLD\"\$/name = \"$NEW\"/" "programs/$NEW/Cargo.toml"
sed -i "s/^pub mod $OLD {/pub mod $NEW {/" "programs/$NEW/src/lib.rs"
sed -i "s/^$OLD = /$NEW = /" Anchor.toml
if [ -f tests/Cargo.toml ]; then
  sed -i "s#package = \"$OLD\", path = \"../programs/$OLD\"#package = \"$NEW\", path = \"../programs/$NEW\"#" tests/Cargo.toml
fi

echo "renamed $OLD to $NEW. Left to check by hand:"
grep -rn "$OLD" --include=*.toml --include=*.rs --include=*.md . 2>/dev/null | grep -v "^./Cargo.lock" | grep -v "/Cargo.lock:" || echo "  nothing: the old name is gone"
