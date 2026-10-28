#!/usr/bin/env bash
# A local Solana test validator with the Metaplex programs preloaded.
# Run inside WSL (or any Linux shell):  bash scripts/localnet.sh [up|start|stop|status]
#
#   up      starts the chain with all seven programs already on it, at their own ids, with
#           the localnet deployer as upgrade authority. Needs NO program keypair: this is
#           the way to try everything on a new machine. Next: node scripts/init-platform.mjs localnet
#   start   starts an empty chain. Next: bash deploy.sh localnet (needs the program
#           keypairs), which rehearses the real deploy.
# Only the validator THIS script started is ever stopped (pid file), never other processes.
set -euo pipefail
cd "$(dirname "$0")/.."
# anchor re-points "active_release" at the Solana version it was built for (3.0.0) on every
# build. That release's test validator ships a Token-2022 that cannot write a mint's
# metadata. So the validator and the deploys run from the NEWEST release installed here,
# whatever "active_release" says. Override with SOLHOOKS_SOLANA_BIN.
newest_solana_bin() {
  for d in "$HOME"/.local/share/solana/install/releases/*/solana-release/bin; do
    [ -x "$d/solana" ] && echo "$("$d/solana" --version | awk '{print $2}') $d"
  done | sort -V | tail -n 1 | cut -d" " -f2-
}
SOLANA_BIN="${SOLHOOKS_SOLANA_BIN:-$(newest_solana_bin)}"
export PATH="${SOLANA_BIN:-$HOME/.local/share/solana/install/active_release/bin}:$PATH"

LEDGER="$HOME/test-ledger-sol-hooks"
PIDFILE="$HOME/test-ledger-sol-hooks.pid"
LOG="$HOME/test-validator-sol-hooks.log"
MPL=metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
CORE=CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d
RPC="http://127.0.0.1:8899"
# SIMD-0500 "Disable deployment of SBPF v0, v1 and v2 programs". The test validator turns
# every feature on, this one included, and our programs are built as SBPF v0 (the LiteSVM
# the tests run on needs v0). Off here so they deploy. Before a public deploy, check
# "solana feature status" on that cluster: where this feature is active, the programs
# have to be built as SBPF v3.
NO_V0_DEPLOYS=B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g

status() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "validator running, pid $(cat "$PIDFILE")"; solana cluster-version -u "$RPC" 2>/dev/null || true
  else
    echo "validator not running"
  fi
}

stop() {
  if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE")"
    if kill -0 "$pid" 2>/dev/null; then kill "$pid"; sleep 1; fi
    rm -f "$PIDFILE"
    echo "stopped $pid"
  else
    echo "nothing to stop"
  fi
}

PROGRAMS=(hookpool hooklaunch hook_tax hook_launch_guard hook_buyback hook_collectible hook_rules)
# The id a program declares, read from Anchor.toml [programs.localnet].
program_id() {
  awk -v p="$1" '/^\[programs\.localnet\]/{f=1;next} /^\[/{f=0} f && $1==p {gsub(/"/,"",$3); print $3}' Anchor.toml
}

# `start` with extra validator arguments: `up` passes the seven programs.
start() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then status; return; fi
  rm -rf "$LEDGER"
  nohup solana-test-validator \
    --reset --quiet \
    --deactivate-feature "$NO_V0_DEPLOYS" \
    --ledger "$LEDGER" \
    --rpc-port 8899 \
    --bpf-program "$MPL" tests/fixtures/mpl_token_metadata.so \
    --bpf-program "$CORE" tests/fixtures/mpl_core.so \
    "$@" \
    > "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  for i in $(seq 1 60); do
    if solana cluster-version -u "$RPC" >/dev/null 2>&1; then echo "validator up at $RPC (pid $(cat "$PIDFILE"))"; return; fi
    sleep 1
  done
  echo "validator did not come up; see $LOG"; tail -n 20 "$LOG"; exit 1
}

# The seven programs on the chain from its first block, upgradeable by the localnet deployer.
up() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then status; return; fi
  local secrets="${SOLHOOKS_SECRETS:-$HOME/sol-secrets}"
  local deployer="$secrets/localnet-deployer.json"
  mkdir -p "$secrets"
  if [ ! -f "$deployer" ]; then
    solana-keygen new --no-bip39-passphrase --silent --outfile "$deployer" >/dev/null
    echo "created the localnet deployer keypair in $secrets"
  fi
  local authority; authority="$(solana-keygen pubkey "$deployer")"
  local args=() rows=() p id
  for p in "${PROGRAMS[@]}"; do
    [ -f "target/deploy/$p.so" ] || { echo "missing target/deploy/$p.so, run build.sh build first"; exit 1; }
    id="$(program_id "$p")"
    [ -n "$id" ] || { echo "no id for $p in Anchor.toml [programs.localnet]"; exit 1; }
    args+=(--upgradeable-program "$id" "target/deploy/$p.so" "$authority")
    rows+=("    \"$p\": \"$id\"")
  done
  start "${args[@]}"
  solana airdrop 500 "$authority" -u "$RPC" >/dev/null 2>&1 || true
  mkdir -p web/deployments
  {
    echo "{"
    echo "  \"cluster\": \"localnet\","
    echo "  \"rpc\": \"$RPC\","
    echo "  \"deployer\": \"$authority\","
    echo "  \"programs\": {"
    local i; for i in "${!rows[@]}"; do if [ "$i" -lt $((${#rows[@]}-1)) ]; then echo "${rows[$i]},"; else echo "${rows[$i]}"; fi; done
    echo "  },"
    echo "  \"deployedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
    echo "}"
  } > web/deployments/localnet.json
  echo "${#PROGRAMS[@]} programs preloaded, upgrade authority $authority"
  echo "wrote web/deployments/localnet.json. Next: node scripts/init-platform.mjs localnet"
}

case "${1:-start}" in
  up) up ;;
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 [up|start|stop|status]"; exit 1 ;;
esac
