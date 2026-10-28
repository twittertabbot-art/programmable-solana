# Shared setup for the scripts in this folder. It is sourced by them, never run.
#
# After it has run:
#   KIT_DIR           the folder these scripts are in
#   HOOK_DIR          the hook project (the folder that holds Anchor.toml)
#   PROGRAM           the program's crate name: the one folder under programs/
#   HOOK_OUT          where this hook's build output and its program keypair live
#   CARGO_TARGET_DIR  the same folder, exported, whatever the calling shell had set
#   PATH              the Solana CLI, cargo and anchor in front
#
# Environment you may set before calling any script:
#   HOOK_DIR          another hook project to work on with these same scripts (the two
#                     examples under examples/hooks/ are built, tested and deployed
#                     this way). Default: the folder these scripts are in.
#   PROGRAM           only needed when programs/ holds more than one program
#   HOOK_TARGET_DIR   another place for the build output.
#                     Default: ~/targets/<name of the hook project's folder>
#   SOLANA_BIN        folder of the Solana CLI to use. Default: the newest release under
#                     ~/.local/share/solana/install/releases, else whatever is on PATH

fail() { echo "error: $*" >&2; exit 1; }

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_DIR="${HOOK_DIR:-$KIT_DIR/..}"
[ -f "$HOOK_DIR/Anchor.toml" ] || fail "no hook project at $HOOK_DIR (it has no Anchor.toml)"
HOOK_DIR="$(cd "$HOOK_DIR" && pwd)"
cd "$HOOK_DIR"

# ---- the Solana CLI ------------------------------------------------------------------
# `anchor build` re-points the installer's "active_release" link at another release, so
# that link is never trusted here. The newest installed release is used instead.
newest_solana_bin() {
  local d
  for d in "$HOME"/.local/share/solana/install/releases/*/solana-release/bin; do
    [ -x "$d/solana" ] && echo "$("$d/solana" --version | awk '{print $2}') $d"
  done | sort -V | tail -n 1 | cut -d" " -f2-
}
SOLANA_BIN="${SOLANA_BIN:-$(newest_solana_bin)}"
export PATH="${SOLANA_BIN:+$SOLANA_BIN:}$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"
for tool in solana solana-keygen anchor cargo node; do
  command -v "$tool" >/dev/null 2>&1 || fail "'$tool' is not installed or not on PATH (see 'What you need' in README.md)"
done

# ---- the program name ----------------------------------------------------------------
if [ -z "${PROGRAM:-}" ]; then
  found=()
  for d in programs/*/; do
    [ -f "${d}Cargo.toml" ] && found+=("$(basename "$d")")
  done
  [ "${#found[@]}" -eq 1 ] || fail "expected exactly one program under programs/, found ${#found[@]}. Set PROGRAM=<crate name>."
  PROGRAM="${found[0]}"
fi
[ -f "programs/$PROGRAM/Cargo.toml" ] || fail "no program at programs/$PROGRAM"

# ---- the build output ----------------------------------------------------------------
# Always this project's own folder, never one inherited from the shell: it holds the
# program keypair, and a build written anywhere else would be deployed stale.
HOOK_OUT="${HOOK_TARGET_DIR:-$HOME/targets/$(basename "$HOOK_DIR")}"
mkdir -p "$HOOK_OUT/deploy"
HOOK_OUT="$(cd "$HOOK_OUT" && pwd)"
export CARGO_TARGET_DIR="$HOOK_OUT"
# The folder remembers which project it belongs to. A copy of this project with the same
# folder name must not build into the original's output and deploy with its keypair.
if [ -f "$HOOK_OUT/.hook-project" ] && [ "$(cat "$HOOK_OUT/.hook-project")" != "$HOOK_DIR" ]; then
  echo "error: the build folder $HOOK_OUT belongs to another hook project:" >&2
  echo "         $(cat "$HOOK_OUT/.hook-project")" >&2
  echo "       It holds that project's program keypair. Give this project its own folder:" >&2
  echo "         HOOK_TARGET_DIR=<a new folder> bash scripts/<script>.sh" >&2
  echo "       If you only moved or renamed the project, delete $HOOK_OUT/.hook-project" >&2
  exit 1
fi
printf '%s\n' "$HOOK_DIR" > "$HOOK_OUT/.hook-project"

PROGRAM_KEYPAIR="$HOOK_OUT/deploy/$PROGRAM-keypair.json"
PROGRAM_SO="$HOOK_OUT/deploy/$PROGRAM.so"

# The program id is the public key of a keypair file in the build folder. It is created
# on the first build. Keep that file until the program is frozen; nobody needs it after.
ensure_program_keypair() {
  if [ ! -f "$PROGRAM_KEYPAIR" ]; then
    solana-keygen new --no-bip39-passphrase --silent --outfile "$PROGRAM_KEYPAIR" >/dev/null
    echo "new program keypair: $PROGRAM_KEYPAIR"
  fi
  PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
}

# Build as SBPF v0 with the program id of the keypair written into the source first
# (declare_id! in src/lib.rs and Anchor.toml), so the binary and its address always agree.
build_hook() {
  ensure_program_keypair
  anchor keys sync >/dev/null
  anchor build --arch v0
  [ -f "$PROGRAM_SO" ] || fail "the build did not produce $PROGRAM_SO"
}
