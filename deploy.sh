#!/usr/bin/env bash
# hookpool deploy helper. Run inside WSL from the repo root:
#
#   bash deploy.sh localnet              deploys all seven programs to the local test validator
#   bash deploy.sh devnet                deploys to devnet (airdrop-funded deployer)
#   bash deploy.sh mainnet               DRY RUN: shows deployer, balance, binary sizes and rent. Sends NOTHING.
#   bash deploy.sh mainnet broadcast     REAL mainnet deploy. It sends transactions and spends SOL.
#
# Secrets live OUTSIDE this folder, in $SOLHOOKS_SECRETS or, by default, ~/sol-secrets:
#   program-keys/<program>.json   program id keypairs (same ids on every cluster)
#   <cluster>-deployer.json       the wallet that pays and holds the upgrade authority
# Nothing in this script prints a private key. One thing to know: the Solana CLI (Agave 4.3)
# prints a 12-word phrase for its buffer account during EVERY deploy, also one that
# finishes. Keep it out of logs you share. It matters only when a deploy is cut off: it
# then resumes the deploy, or takes the SOL in the buffer back.
set -euo pipefail
cd "$(dirname "$0")"
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

CLUSTER="${1:-}"; MODE="${2:-dry}"
[ -n "$CLUSTER" ] || { echo "usage: $0 <localnet|devnet|mainnet> [broadcast]"; exit 1; }
SECRETS="${SOLHOOKS_SECRETS:-$HOME/sol-secrets}"
KEYS="$SECRETS/program-keys"
DEPLOYER="$SECRETS/$CLUSTER-deployer.json"

# Settings that must not be typed on a command line (they would stay in the shell history)
# live in $SECRETS/<cluster>.env, one NAME=value per line, no quotes:
#   MAINNET_RPC or DEVNET_RPC   the paid RPC the deploy sends through (its key stays private)
#   SITE_RPC                    the RPC the website may show to every visitor: give the one
#                               locked to the site's domain. It is written into
#                               web/deployments/<cluster>.json, which the site publishes.
#   PRIORITY_MICROLAMPORTS      the priority fee of the upload transactions (default 100000;
#                               the CLI sets tight limits, so the whole deploy pays about
#                               0.003 SOL more for it)
# No value of this file is ever printed: an RPC is shown by its host only.
ENVFILE="$SECRETS/$CLUSTER.env"
if [ "$CLUSTER" != "localnet" ] && [ -f "$ENVFILE" ]; then
  while IFS='=' read -r k v; do
    case "$k" in MAINNET_RPC|DEVNET_RPC|SITE_RPC|PRIORITY_MICROLAMPORTS) export "$k=$v" ;; esac
  done < <(grep -E '^[A-Z_]+=' "$ENVFILE" | tr -d '\r')
fi

case "$CLUSTER" in
  localnet) RPC="http://127.0.0.1:8899"; PUBLIC_RPC="$RPC" ;;
  devnet)   RPC="${DEVNET_RPC:-https://api.devnet.solana.com}"; PUBLIC_RPC="https://api.devnet.solana.com" ;;
  mainnet)  RPC="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"; PUBLIC_RPC="https://api.mainnet-beta.solana.com" ;;
  *) echo "unknown cluster $CLUSTER"; exit 1 ;;
esac
# what the site may publish: never the deploy's own RPC unless it is the public one
if [ "$CLUSTER" = "localnet" ]; then SITE_RPC_OUT="$RPC"; else SITE_RPC_OUT="${SITE_RPC:-$PUBLIC_RPC}"; fi
host_of() { echo "$1" | sed -E 's#^(https?://[^/?]+).*#\1#'; }
# The Solana CLI prints the full RPC address in its errors: pipe its output through this.
redact() { awk -v s="$RPC" -v r="$(host_of "$RPC")/(key hidden)" '{ while (s != "" && (i = index($0, s)) > 0) $0 = substr($0, 1, i - 1) r substr($0, i + length(s)); print; fflush() }'; }
# the upload transactions of a public cluster carry a priority fee, so they land when it is busy
PRIO=()
if [ "$CLUSTER" != "localnet" ]; then PRIO=(--with-compute-unit-price "${PRIORITY_MICROLAMPORTS:-100000}" --max-sign-attempts 30); fi

# ONLY="hookpool hook_tax" deploys a subset (useful while devnet funds arrive one faucet request at a time)
PROGRAMS=(hookpool hooklaunch hook_tax hook_launch_guard hook_buyback hook_collectible hook_rules)
if [ -n "${ONLY:-}" ]; then read -r -a PROGRAMS <<< "$ONLY"; fi
for p in "${PROGRAMS[@]}"; do
  [ -f "target/deploy/$p.so" ] || { echo "missing target/deploy/$p.so, run build.sh first"; exit 1; }
  [ -f "$KEYS/$p.json" ] || { echo "missing program keypair $KEYS/$p.json"; exit 1; }
done

if [ ! -f "$DEPLOYER" ]; then
  if [ "$CLUSTER" = "mainnet" ]; then
    echo "missing $DEPLOYER. Put the mainnet deployer keypair there (never in this folder)."; exit 1
  fi
  mkdir -p "$SECRETS"
  solana-keygen new --no-bip39-passphrase --silent --outfile "$DEPLOYER" >/dev/null
  echo "created $CLUSTER deployer keypair"
fi

ADDR="$(solana-keygen pubkey "$DEPLOYER")"
echo "cluster   : $CLUSTER  ($(host_of "$RPC"))"
echo "site rpc  : $(host_of "$SITE_RPC_OUT")  (written into web/deployments/$CLUSTER.json, public)"
if [ ${#PRIO[@]} -gt 0 ]; then echo "priority  : ${PRIO[1]} micro-lamports per compute unit"; fi
echo "deployer  : $ADDR"

if [ "$CLUSTER" != "mainnet" ]; then
  BAL="$(solana balance "$ADDR" -u "$RPC" 2>/dev/null | awk '{print $1}')"
  if [ "${BAL%%.*}" -lt 20 ] 2>/dev/null || [ -z "$BAL" ]; then
    echo "airdropping to the deployer"
    for i in 1 2 3 4 5; do solana airdrop 5 "$ADDR" -u "$RPC" >/dev/null 2>&1 && break || sleep 2; done
    if [ "$CLUSTER" = "localnet" ]; then for i in 1 2 3 4; do solana airdrop 100 "$ADDR" -u "$RPC" >/dev/null 2>&1 || true; done; fi
  fi
fi
BAL="$( (solana balance "$ADDR" -u "$RPC" 2>&1 || true) | redact | awk '{print $1}')"
case "$BAL" in ''|*[!0-9.]*) echo "could not read the deployer's balance through $(host_of "$RPC"):"; solana balance "$ADDR" -u "$RPC" 2>&1 | redact | head -3; exit 1 ;; esac
echo "balance   : $BAL SOL"

TOTAL_BYTES=0
echo
echo "program            size (KB)   rent (SOL, approx)   program id"
for p in "${PROGRAMS[@]}"; do
  SZ=$(stat -c %s "target/deploy/$p.so")
  TOTAL_BYTES=$((TOTAL_BYTES + SZ))
  RENT=$(awk -v s="$SZ" 'BEGIN{printf "%.3f", (s+45)*0.00000696}')
  printf "%-18s %-11s %-20s %s\n" "$p" "$((SZ/1024))" "$RENT" "$(solana-keygen pubkey "$KEYS/$p.json")"
done
echo "total     : $((TOTAL_BYTES/1024)) KB, about $(awk -v s="$TOTAL_BYTES" 'BEGIN{printf "%.2f", s*0.00000696}') SOL of rent (recoverable while you hold the upgrade authority)"
echo

# These binaries are SBPF v0. SIMD-0500, once active on a cluster, refuses to deploy them.
if [ "$CLUSTER" != "localnet" ]; then
  V0_GATE=B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g
  V0_STATUS="$(solana feature status "$V0_GATE" -u "$RPC" 2>/dev/null | awk -v id="$V0_GATE" '$1==id {print $3}' || true)"
  echo "SBPF v0 deploys on $CLUSTER: feature $V0_GATE is ${V0_STATUS:-unknown}"
  if [ "$V0_STATUS" = "active" ]; then
    echo "This cluster no longer accepts SBPF v0 programs. Build them as v3 first (README.md, Toolchain)."
    exit 1
  fi
  echo
fi

if [ "$CLUSTER" = "mainnet" ] && [ "$MODE" != "broadcast" ]; then
  echo "DRY RUN. Nothing was sent. To deploy for real: bash deploy.sh mainnet broadcast"
  exit 0
fi

for p in "${PROGRAMS[@]}"; do
  PID="$(solana-keygen pubkey "$KEYS/$p.json")"
  if solana program show "$PID" -k "$DEPLOYER" -u "$RPC" >/dev/null 2>&1; then
    echo "== $p already deployed at $PID, upgrading in place"
    solana program deploy "target/deploy/$p.so" --program-id "$PID" --upgrade-authority "$DEPLOYER" -k "$DEPLOYER" -u "$RPC" --use-rpc "${PRIO[@]}" 2>&1 | redact
  else
    echo "== deploying $p"
    solana program deploy "target/deploy/$p.so" --program-id "$KEYS/$p.json" --upgrade-authority "$DEPLOYER" -k "$DEPLOYER" -u "$RPC" --use-rpc "${PRIO[@]}" 2>&1 | redact
  fi
done

echo
echo "deployed. Next: node scripts/init-platform.mjs $CLUSTER"
mkdir -p web/deployments
cat > "web/deployments/$CLUSTER.json" <<EOF
{
  "cluster": "$CLUSTER",
  "rpc": "$SITE_RPC_OUT",
  "deployer": "$ADDR",
  "programs": {
$(for i in "${!PROGRAMS[@]}"; do p=${PROGRAMS[$i]}; sep=","; [ "$i" -eq $((${#PROGRAMS[@]}-1)) ] && sep=""; echo "    \"$p\": \"$(solana-keygen pubkey "$KEYS/$p.json")\"$sep"; done)
  },
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "wrote web/deployments/$CLUSTER.json"
