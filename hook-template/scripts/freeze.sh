#!/usr/bin/env bash
# Freeze a deployed hook: remove its upgrade authority, for good. Run inside Linux or WSL:
#   bash scripts/freeze.sh [localnet|devnet|mainnet]        (default: localnet)
#
# The hook must already be deployed by scripts/deploy-freeze.sh with FREEZE=no (the default
# on mainnet), by the wallet that is still its upgrade authority.
#
# On mainnet it first reads the verification service that Solana's explorers use
# (https://verify.osec.io) and stops unless the program is verified there and the verified
# build is exactly the program on chain. The order matters: only the upgrade authority can
# upload the build record, so after the freeze nobody can. Programmable approves a hook only
# when its frozen program is the verified build of the reviewed commit.
#
# Environment:
#   WALLET           keypair file of the upgrade authority (default ~/.config/solana/id.json)
#   FREEZE           ask (default): asks on the terminal. yes: freezes without asking
#   CHECK_VERIFIED   yes on mainnet (default), no elsewhere. Set it to yes to check on
#                    another cluster; on mainnet it cannot be turned off
#   VERIFY_API       the verification service (default https://verify.osec.io)
#   LOCALNET_RPC, DEVNET_RPC, MAINNET_RPC   another RPC address for that cluster
set -euo pipefail
source "$(dirname "$0")/env.sh"

CLUSTER="${1:-localnet}"
case "$CLUSTER" in
  localnet) RPC="${LOCALNET_RPC:-http://127.0.0.1:8899}" ;;
  devnet)   RPC="${DEVNET_RPC:-https://api.devnet.solana.com}" ;;
  mainnet)  RPC="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}" ;;
  *) echo "usage: bash scripts/freeze.sh [localnet|devnet|mainnet]"; exit 1 ;;
esac
WALLET="${WALLET:-$HOME/.config/solana/id.json}"
FREEZE="${FREEZE:-ask}"
VERIFY_API="${VERIFY_API:-https://verify.osec.io}"
if [ "$CLUSTER" = "mainnet" ]; then CHECK_VERIFIED=yes; else CHECK_VERIFIED="${CHECK_VERIFIED:-no}"; fi

[ -f "$WALLET" ] || fail "wallet keypair not found: $WALLET (set WALLET=<keypair file>)"
[ -f "$PROGRAM_KEYPAIR" ] || fail "no program keypair at $PROGRAM_KEYPAIR: deploy first (scripts/deploy-freeze.sh)"
PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
WALLET_ADDRESS="$(solana-keygen pubkey "$WALLET")"
echo "cluster    : $CLUSTER ($RPC)"
echo "program id : $PROGRAM_ID"

SHOW="$(solana program show "$PROGRAM_ID" -u "$RPC" -k "$WALLET" 2>&1)" || fail "$PROGRAM_ID is not deployed on $CLUSTER"
if printf '%s\n' "$SHOW" | grep -q "^Authority: none"; then
  echo "$PROGRAM_ID is already frozen. Nothing to do."
  exit 0
fi
AUTH="$(printf '%s\n' "$SHOW" | awk '/^Authority:/ {print $2}')"
[ "$AUTH" = "$WALLET_ADDRESS" ] || fail "the upgrade authority is $AUTH, not this wallet ($WALLET_ADDRESS)"

if [ "$CHECK_VERIFIED" = "yes" ]; then
  echo "checking the verified build at $VERIFY_API ..."
  node -e '
    const [api, id] = process.argv.slice(1);
    fetch(api + "/status/" + id, { signal: AbortSignal.timeout(15000) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("it answered " + r.status))))
      .then((s) => {
        console.log("verified   : " + (s.is_verified ? "yes" : "NO") + (s.message ? " (" + s.message + ")" : ""));
        console.log("repository : " + (s.repo_url || "none") + "  commit " + (s.commit || "none"));
        console.log("on chain   : " + (s.on_chain_hash || "none"));
        console.log("build      : " + (s.executable_hash || "none"));
        if (!s.is_verified || !s.executable_hash || s.executable_hash !== s.on_chain_hash) process.exit(3);
      }, (e) => { console.error("the verification service could not be read: " + e.message); process.exit(4); });
  ' "$VERIFY_API" "$PROGRAM_ID" || fail "not frozen: the program is not the verified build of a commit yet.
       Upload the build record and ask for the remote verification (README.md, \"Release on mainnet\"),
       wait until $VERIFY_API/status/$PROGRAM_ID says it is verified, then run this again."
fi

echo
echo "About to remove the upgrade authority of $PROGRAM_ID on $CLUSTER. This cannot be undone."
case "$FREEZE" in
  yes) ;;
  ask)
    if [ ! -t 0 ]; then echo "Not frozen: there is no terminal to ask on. Run again with FREEZE=yes."; exit 0; fi
    read -r -p "type FREEZE to continue: " answer
    [ "$answer" = "FREEZE" ] || { echo "Not frozen."; exit 0; }
    ;;
  *) fail "FREEZE must be ask or yes (it is '$FREEZE')" ;;
esac
solana program set-upgrade-authority "$PROGRAM_ID" --final -k "$WALLET" -u "$RPC"
solana program show "$PROGRAM_ID" -u "$RPC" -k "$WALLET" | grep -q "^Authority: none" \
  || fail "the freeze did not take: check 'solana program show $PROGRAM_ID'"
echo
echo "Frozen. $PROGRAM_ID can never change again."
echo "Give this program id on your review request page: Programmable checks it and puts it on the approved list."
