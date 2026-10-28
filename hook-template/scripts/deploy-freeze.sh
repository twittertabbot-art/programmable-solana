#!/usr/bin/env bash
# Build, deploy, publish the manifest, FREEZE. Run inside Linux or WSL, from anywhere:
#   bash scripts/deploy-freeze.sh [localnet|devnet|mainnet]        (default: localnet)
#
# Environment:
#   WALLET      keypair file that pays and holds the upgrade authority until the freeze
#               (default ~/.config/solana/id.json)
#   HOOK_NAME   name written into the manifest, at most 32 bytes (default: the program name)
#   HOOK_URI    link written into the manifest, at most 128 bytes. Give the address of
#               your hosted hook.json (the descriptor: README.md, "Describe your hook")
#               and sites show the hook with its rules and its settings form. Any other
#               link is shown as a plain link.
#               The script adds "#s=<pin of the hosted file>" to it, which pins the
#               content. The pin is 22 characters, so with it the address may have 103
#               bytes at most.
#   DESCRIPTOR_PIN     no  links the descriptor without pinning its content
#   DESCRIPTOR_CHECK   no  skips the reading of the file at HOOK_URI (see below)
#   FREEZE      ask  (default) asks on the terminal before freezing; without a terminal
#                    it stops before the freeze and says so
#               yes  freezes without asking
#               no   deploys and publishes the manifest, then stops before the freeze
#                    (the default on mainnet: there the freeze comes after the verified
#                    build, with scripts/freeze.sh; README.md, "Release on mainnet")
#   SO_FILE     deploy this program file instead of building one. On mainnet it is
#               required: the file that `solana-verify build` wrote, so that anyone can
#               rebuild the same bytes from your commit
#   LOCALNET_RPC, DEVNET_RPC, MAINNET_RPC   another RPC address for that cluster
#   HOOK_DIR, PROGRAM, HOOK_TARGET_DIR, SOLANA_BIN    see scripts/env.sh
#
# On mainnet a hook opens pools only once Programmable has reviewed and approved it
# (https://programmableonsol.com/review-hook.html): send the review request with the
# repository and the commit BEFORE you deploy, and deploy exactly that commit.
#
# Freezing is final. The program's code can never change again, the program can never
# be closed, and the SOL that pays its rent never comes back. The pool refuses a hook
# that is not frozen, so a hook can only be tried on a real pool after this step: test
# it first (bash scripts/test.sh), and expect a NEW program id for every fix.
#
# The script stops before building or sending anything when the Programmable pool program
# is not on the cluster you name: a hook frozen there could never be used.
set -euo pipefail
source "$(dirname "$0")/env.sh"

# The pool program. The same id as in the interface crate (crates/hookpool-interface).
POOL_PROGRAM="7CL4KGeaZFsNYqEjErwTezMYuAE54185TieqLQnGjdgh"

CLUSTER="${1:-localnet}"
case "$CLUSTER" in
  localnet) RPC="${LOCALNET_RPC:-http://127.0.0.1:8899}" ;;
  devnet)   RPC="${DEVNET_RPC:-https://api.devnet.solana.com}" ;;
  mainnet)  RPC="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}" ;;
  *) echo "usage: bash scripts/deploy-freeze.sh [localnet|devnet|mainnet]"; exit 1 ;;
esac
WALLET="${WALLET:-$HOME/.config/solana/id.json}"
NAME="${HOOK_NAME:-$PROGRAM}"
URI="${HOOK_URI:-https://example.com/$PROGRAM}"
if [ "$CLUSTER" = "mainnet" ]; then FREEZE="${FREEZE:-no}"; else FREEZE="${FREEZE:-ask}"; fi
SO_FILE="${SO_FILE:-}"

# ---- checks, before anything is built or sent ----------------------------------------
case "$FREEZE" in ask|yes|no) ;; *) fail "FREEZE must be ask, yes or no (it is '$FREEZE')" ;; esac
if [ "$CLUSTER" = "mainnet" ]; then
  [ -n "$SO_FILE" ] || fail "on mainnet the program file must be the verifiable build: run 'solana-verify build --library-name $PROGRAM'
       in the hook's folder at the reviewed commit, then SO_FILE=<the .so it wrote> (README.md, \"Release on mainnet\").
       Nothing was built or sent."
  [ "$FREEZE" != "yes" ] || fail "on mainnet the freeze comes after the verified build: deploy with FREEZE=no, then run scripts/freeze.sh mainnet.
       Nothing was built or sent."
fi
if [ -n "$SO_FILE" ]; then [ -f "$SO_FILE" ] || fail "SO_FILE not found: $SO_FILE"; fi
[ -f "$WALLET" ] || fail "wallet keypair not found: $WALLET (set WALLET=<keypair file>)"
[ "$(printf %s "$NAME" | wc -c)" -le 32 ] || fail "HOOK_NAME is longer than 32 bytes"
[ "$(printf %s "$URI" | wc -c)" -le 128 ] || fail "HOOK_URI is longer than 128 bytes"
# Step 4 runs a Node script that needs @solana/web3.js. Find out now, not after the deploy.
node "$KIT_DIR/publish-manifest.mjs" --check 2>/dev/null || fail "step 4 needs the Node package @solana/web3.js and Node cannot find it.
       Inside the Programmable repository: run 'npm install' at the repository root.
       Anywhere else: run 'npm install @solana/web3.js' in $(dirname "$KIT_DIR")"
solana cluster-version -u "$RPC" -k "$WALLET" >/dev/null 2>&1 || fail "cannot reach $CLUSTER at $RPC"
if ! solana program show "$POOL_PROGRAM" -u "$RPC" -k "$WALLET" >/dev/null 2>&1; then
  echo "Programmable's pool program ($POOL_PROGRAM) is not on $CLUSTER ($RPC)."
  if [ "$CLUSTER" = "localnet" ]; then
    echo "Start a local chain with Programmable on it first. From the repository root:"
    echo "  bash build.sh build"
    echo "  bash scripts/localnet.sh up"
    echo "  node scripts/init-platform.mjs localnet"
  else
    echo "A hook frozen there could not be used by any pool, and the SOL that pays its"
    echo "rent would never come back. Use a local chain: bash scripts/deploy-freeze.sh localnet"
  fi
  echo "Nothing was built or sent."
  exit 1
fi

# ---- 1. program keypair and id -------------------------------------------------------
ensure_program_keypair
WALLET_ADDRESS="$(solana-keygen pubkey "$WALLET")"
echo "cluster    : $CLUSTER ($RPC)"
echo "solana cli : $(solana --version)"
echo "program    : $PROGRAM"
echo "program id : $PROGRAM_ID"
echo "wallet     : $WALLET_ADDRESS  balance $(solana balance "$WALLET_ADDRESS" -u "$RPC" -k "$WALLET")"

# A frozen program cannot be deployed again: say so instead of failing halfway.
if solana program show "$PROGRAM_ID" -u "$RPC" -k "$WALLET" 2>/dev/null | grep -q "^Authority: none"; then
  echo "$PROGRAM_ID is already frozen on $CLUSTER. Nothing to do."
  echo "To ship a change, delete $PROGRAM_KEYPAIR"
  echo "and run again: the hook becomes a new program with a new id."
  exit 0
fi

# ---- the descriptor ------------------------------------------------------------------
# hook.json describes this hook to sites. Its "program" must be this program's id, or a
# site refuses it, and the link to it is written into the manifest once and never again.
# So the local file gets the id (as the build does with declare_id!), and the hosted file
# is read before anything is sent: a file that names another program stops the deploy.
if [ -f "$HOOK_DIR/hook.json" ]; then
  node -e '
    const fs = require("fs");
    const [file, id] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8");
    const now = (/"program"\s*:\s*"([^"]*)"/.exec(text) || [])[1];
    if (now === undefined) { console.error("hook.json has no \"program\" field"); process.exit(1); }
    if (now !== id) { fs.writeFileSync(file, text.replace(/("program"\s*:\s*")[^"]*(")/, "$1" + id + "$2")); console.log("descriptor : hook.json now names " + id + " (it named " + (now || "nothing") + ")"); }
  ' "$HOOK_DIR/hook.json" "$PROGRAM_ID" || fail "hook.json could not be read"
fi
#
# The pin. The manifest names the ADDRESS of the descriptor, and an address alone would let
# its author put another text there later. So the link may end with "#s=" and a pin: the
# first 16 bytes of the SHA-256 of the file, as 22 characters of base64url without padding.
# A site then refuses any other file at that address. When HOOK_URI carries no pin and the
# hosted file can be read and is a descriptor of this program, the pin of that file is added
# here. When HOOK_URI carries one, the hosted file has to match it. A pin proves that the
# file is the one you pinned. It is not a signature, and it says nothing about the code.
# The Node step below prints the link to use and nothing else on its standard output. With
# DESCRIPTOR_CHECK=no it reads nothing and only checks how the link is written.
case "$URI" in
  *.json|*.json\#*)
    URI="$(node -e '
      const crypto = require("crypto");
      const [uri, id, pinning, reading] = process.argv.slice(1);
      const cut = uri.indexOf("#");
      const address = cut < 0 ? uri : uri.slice(0, cut);
      const fragment = cut < 0 ? "" : uri.slice(cut + 1);
      const given = fragment.startsWith("s=") ? fragment.slice(2) : "";
      const say = (t) => console.error("descriptor : " + t);
      const stop = (t) => { console.error(t); process.exit(1); };
      if (cut >= 0 && !fragment.startsWith("s=")) stop("HOOK_URI ends with \"#" + fragment + "\". That is not a pin, and a site would read the link as not pinned. A pin is \"#s=\" and 22 characters. Give the address alone and this script adds the pin.");
      if (cut >= 0 && !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(given)) stop("The pin in HOOK_URI is not one. After \"#s=\" a pin has 22 characters: the first 16 bytes of the SHA-256 of the file, in base64url without padding. Give the address alone and this script adds the pin.");
      if (reading === "no") { say("the file at " + address + " was not read (DESCRIPTOR_CHECK=no)" + (given ? "" : ". The link is NOT pinned")); console.log(uri); }
      else fetch(address, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("it answered " + r.status)))).then((buf) => {
        const bytes = Buffer.from(buf);
        let j = null;
        try { j = JSON.parse(bytes.toString("utf8")); } catch (_) {}
        if (!j || j.programmable_hook !== 1) stop("The file at " + address + " is not a hook descriptor (\"programmable_hook\": 1 is missing). Host the hook.json of this folder there.");
        if (j.program !== id) stop("The file at " + address + " names the program " + j.program + ". This hook is " + id + ". Host the hook.json of this folder there.");
        const pin = crypto.createHash("sha256").update(bytes).digest().subarray(0, 16).toString("base64url");
        if (given && given !== pin) stop("HOOK_URI pins " + given + ". The file at " + address + " has the pin " + pin + ". Give the address alone and this script adds the pin of the file that is there.");
        if (given) { say(address + " names this program and is the file the link pins"); console.log(uri); }
        else if (pinning === "no") { say(address + " names this program. The link is not pinned (DESCRIPTOR_PIN=no): sites will say that the author can still change the text"); console.log(uri); }
        else { say(address + " names this program. The link now carries the pin of that file, so sites refuse any other file at that address"); console.log(address + "#s=" + pin); }
      }, (e) => {
        say(address + " could not be read from here (" + e.message + "). Check that it names " + id + " before you freeze." + (given ? "" : " The link is NOT pinned. To pin it, add #s= and the pin of the file to HOOK_URI (README.md, \"The pin\", has the command that prints it)."));
        console.log(uri);
      });
    ' "$URI" "$PROGRAM_ID" "${DESCRIPTOR_PIN:-yes}" "${DESCRIPTOR_CHECK:-yes}")" || fail "the link in HOOK_URI would not work as the address of this hook's descriptor. The line above says why.
       Nothing was built or sent."
    LINK_BYTES="$(printf %s "$URI" | wc -c)"
    OVER=$((LINK_BYTES - 128))
    [ "$OVER" -le 0 ] || fail "the link with the pin of the file is $OVER $([ "$OVER" -eq 1 ] && echo byte || echo bytes) longer than the 128 a manifest holds.
       The pin takes 25 bytes, so an address of at most 103 bytes can be pinned.
       Host hook.json at a shorter address, or deploy without the pin: DESCRIPTOR_PIN=no.
       Sites then say that the author can still change the text.
       Nothing was built or sent."
    echo "link       : $URI" ;;
  *)
    if [ -f "$HOOK_DIR/hook.json" ]; then
      echo "descriptor : HOOK_URI is not the address of a .json file, so the manifest will not link"
      echo "             to hook.json and sites show this hook without its rules. The manifest is"
      echo "             written once."
    fi ;;
esac

# ---- 2. build (or the verifiable build you give) ---------------------------------------
if [ -n "$SO_FILE" ]; then
  PROGRAM_SO="$SO_FILE"
  echo "binary     : $SO_FILE (given, not built here)"
else
  build_hook
fi
SIZE="$(stat -c %s "$PROGRAM_SO")"
RENT="$(solana rent "$SIZE" -u "$RPC" -k "$WALLET" 2>/dev/null | awk '/Rent-exempt minimum/ {print $3, $4}')"
echo "binary     : $SIZE bytes. Rent ${RENT:-unknown}, locked forever once the program is frozen."

# ---- 3. deploy (upgradeable for now, by this wallet) ----------------------------------
solana program deploy "$PROGRAM_SO" --program-id "$PROGRAM_KEYPAIR" \
  --upgrade-authority "$WALLET" -k "$WALLET" -u "$RPC" --use-rpc

# ---- 4. manifest and extra-accounts list ---------------------------------------------
# The instruction checks that the signer is the upgrade authority, so it must run now.
node "$KIT_DIR/publish-manifest.mjs" "$PROGRAM_ID" "$RPC" "$WALLET" "$NAME" "$URI"

# ---- 5. freeze -----------------------------------------------------------------------
echo
echo "About to remove the upgrade authority of $PROGRAM_ID on $CLUSTER. This cannot be undone."
case "$FREEZE" in
  yes) ;;
  no)
    if [ "$CLUSTER" = "mainnet" ]; then
      echo "Not frozen yet, on purpose. Next, with this same wallet still the upgrade authority:"
      echo "  1. upload the build record and ask for the remote verification (README.md, \"Release on mainnet\", step 6)"
      echo "  2. bash scripts/freeze.sh mainnet   (it checks the verification, then freezes)"
      echo "  3. give the program id $PROGRAM_ID on your review request page"
    else
      echo "Not frozen (FREEZE=no). The pool refuses this hook until you run again with FREEZE=yes, or run scripts/freeze.sh $CLUSTER."
    fi
    exit 0 ;;
  ask)
    if [ ! -t 0 ]; then
      echo "Not frozen: there is no terminal to ask on. Run again with FREEZE=yes."
      exit 0
    fi
    read -r -p "type FREEZE to continue: " answer
    [ "$answer" = "FREEZE" ] || { echo "Not frozen."; exit 0; }
    ;;
esac
solana program set-upgrade-authority "$PROGRAM_ID" --final -k "$WALLET" -u "$RPC"
solana program show "$PROGRAM_ID" -u "$RPC" -k "$WALLET" | grep -q "^Authority: none" \
  || fail "the freeze did not take: check 'solana program show $PROGRAM_ID'"
echo
echo "Frozen. $PROGRAM_ID can never change again."
echo "Where Programmable's approved list is on (mainnet), pools accept it once Programmable has approved it:"
echo "give this program id on your review request page."
echo "wallet     : $WALLET_ADDRESS  balance $(solana balance "$WALLET_ADDRESS" -u "$RPC" -k "$WALLET")"
