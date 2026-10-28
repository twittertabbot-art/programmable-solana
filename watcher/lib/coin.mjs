// What kind of coin a pool trades, read from the coin's mint. Pure, so it is tested offline.
//
// A PLAIN coin (SPL Token, or Token-2022 without a transfer hook) runs no program of its own. A PEGGED coin is a
// Token-2022 coin whose transfer hook is the pool's own hook program: that program runs inside EVERY transfer of
// the coin, sells included. The pool program accepts a transfer hook on the coin only when three things hold:
// the hook is the pool's own hook program, the platform runs that program, and no authority is left that could
// point the coin at another program. The watcher assumes none of it. It reads the mint every pass and checks.
// A coin with a transfer hook that breaks one of the three is a danger finding: it should be impossible.
import { PublicKey } from "@solana/web3.js";
import { HOOK_KIND, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, decodeTransferHook, token2022Extension } from "../../sdk/dist/index.js";

/// Token-2022 extension number of TransferHook { authority, program_id }.
const TRANSFER_HOOK_EXTENSION = 14;
const IMPOSSIBLE = "The pool refuses such coins, so this should be impossible. Look at it.";

/// The transfer hook of a mint, as { program, authority }, each base58 or null. null when the mint has none.
/// A mint with no hook program but an authority still set is reported as { program: null, authority }: that key
/// could give the coin a program later. The raw read below stays as a second look that does not depend on the SDK.
export function transferHookOf(mintInfo) {
  if (!mintInfo || !mintInfo.owner || !mintInfo.owner.equals(TOKEN_2022_PROGRAM)) return null;
  const data = new Uint8Array(mintInfo.data);
  try {
    const hook = decodeTransferHook(data);
    if (hook) return { program: hook.program ? hook.program.toBase58() : null, authority: hook.authority ? hook.authority.toBase58() : null };
    const ext = token2022Extension(data, TRANSFER_HOOK_EXTENSION);
    if (ext && ext.length >= 32) {
      const authority = new PublicKey(ext.subarray(0, 32));
      if (!authority.equals(PublicKey.default)) return { program: null, authority: authority.toBase58() };
    }
  } catch { /* a mint that does not parse carries no hook this code can name */ }
  return null;
}

/// The facts about a pool's coin.
///   pool            the decoded pool (baseTokenProgram, hasHook, hookProgram, hookKind)
///   mintInfo        the coin's mint account as the RPC returns it ({ owner, data }), or null when unreadable
///   template        the pool's hook template ("collectible", "tax", ..., "none")
///   collectibleCfg  the decoded collection config of a collectible pool, or null
/// Returns:
///   kind          "plain" (no transfer hook), "pegged" (the verified case below), "mismatch" (a danger finding)
///                 or "unknown" (the mint could not be read this pass)
///   tokenProgram  "spl-token", "token-2022" or "unknown"
///   transferHook  { program, authority } or null
///   runsHook      the coin runs THIS pool's hook program inside every transfer, so that program runs on sells
///   verified      runsHook, and the platform runs that program, and the hook authority is none
///   problems      danger findings, in words. Each one should be impossible.
///   notes         the facts, in words, for the pool report
export function coinFacts({ pool, mintInfo, template, collectibleCfg = null }) {
  const out = { kind: "unknown", tokenProgram: "unknown", transferHook: null, runsHook: false, verified: false, problems: [], notes: [] };
  const isCollectible = template === "collectible";
  if (!mintInfo) {
    out.notes.push("The coin's mint could not be read this pass. What kind of coin it is was not checked.");
    return out;
  }
  const isSpl = mintInfo.owner.equals(TOKEN_PROGRAM);
  const is2022 = mintInfo.owner.equals(TOKEN_2022_PROGRAM);
  out.tokenProgram = isSpl ? "spl-token" : is2022 ? "token-2022" : "unknown";
  if (!isSpl && !is2022) {
    out.kind = "mismatch";
    out.problems.push(`the coin's mint belongs to program ${mintInfo.owner.toBase58()}. That is not a token program. ${IMPOSSIBLE}`);
    return out;
  }
  const hook = transferHookOf(mintInfo);
  out.transferHook = hook;
  const ownProgram = pool.hasHook ? pool.hookProgram.toBase58() : null;
  const says = isCollectible && collectibleCfg ? !!collectibleCfg.pegged : null;   // what the collection config says

  if (!hook) {
    if (says === true) {
      out.kind = "mismatch";
      out.problems.push("the collection config says the coin is pegged, but the coin's mint has no transfer hook. This should be impossible. Look at it.");
      return out;
    }
    out.kind = "plain";
    if (isCollectible) out.notes.push(`Plain coin (${isSpl ? "SPL Token" : "Token-2022 without a transfer hook"}): the coin runs no program of its own. Checked on its mint this pass.`);
    return out;
  }

  out.runsHook = hook.program !== null && hook.program === ownProgram;
  if (hook.program === null) {
    out.problems.push(`the coin has no transfer hook program yet, but ${hook.authority} can set one. That key can point the coin at any program. ${IMPOSSIBLE}`);
  } else {
    if (!out.runsHook) {
      out.problems.push(`the coin runs program ${hook.program} inside every transfer, sells included. ${ownProgram ? "That is not this pool's hook program." : "This pool has no hook, so its coin may run no program."} ${IMPOSSIBLE}`);
    } else if (pool.hookKind !== HOOK_KIND.PLATFORM) {
      out.problems.push(`the coin runs this pool's hook program inside every transfer, sells included, but the platform does not run that program. ${IMPOSSIBLE}`);
    }
    if (hook.authority !== null) {
      out.problems.push(`the coin's transfer hook can still be changed by ${hook.authority}. That key can point the coin at another program. ${IMPOSSIBLE}`);
    }
  }
  if (!out.problems.length && says === false) {
    out.problems.push("the coin runs the collectible program inside every transfer, but the collection config does not say pegged. This should be impossible. Look at it.");
  }
  if (out.problems.length) { out.kind = "mismatch"; return out; }

  // The verified case: the pool's own hook program, run by the platform, with no authority left on the coin.
  out.verified = true;
  out.kind = "pegged";
  out.notes.push(`${isCollectible ? "Pegged coin: a Token-2022 coin" : "This coin is a Token-2022 coin"} whose transfer hook is this pool's own hook program ${hook.program}. Checked on its mint this pass.`);
  out.notes.push("The coin runs that platform program inside every transfer, sells included.");
  out.notes.push("Nobody can change which program the coin runs: its transfer hook authority is none.");
  if (isCollectible) out.notes.push("A plain transfer carries the piece to the receiver, or burns it. The receiver takes one piece per whole unit the transfer sends. A piece burns when the receiver has no ticket, gains no whole unit, or took the coins outside its associated token account.");
  return out;
}

/// The `coin` field of a collectible pool's status entry.
export function coinStatus(facts) {
  return {
    kind: facts.kind, tokenProgram: facts.tokenProgram,
    transferHookProgram: facts.transferHook ? facts.transferHook.program : null,
    transferHookAuthority: facts.transferHook ? facts.transferHook.authority : null,
  };
}
