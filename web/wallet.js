// Injected Solana wallets: Phantom, Solflare, Backpack, plus anything registered through the
// wallet standard (navigator.wallets). One connection at a time, remembered in localStorage.
// Every method here throws a plain Error with a sentence the page can show as is.

const STORE = "Programmable.wallet";
const listeners = new Set();
const W = { name: "", publicKey: null, kind: "", raw: null, account: null };

function emit() { for (const f of listeners) { try { f(W); } catch (_) {} } }
export function onChange(f) { listeners.add(f); return () => listeners.delete(f); }
export function current() { return W; }

// ---- discovery -----------------------------------------------------------------------------

function injected() {
  const out = [];
  const ph = window.phantom && window.phantom.solana;
  if (ph && ph.isPhantom) out.push({ id: "phantom", name: "Phantom", kind: "injected", raw: ph, icon: "" });
  const sf = window.solflare;
  if (sf && (sf.isSolflare || typeof sf.connect === "function")) out.push({ id: "solflare", name: "Solflare", kind: "injected", raw: sf, icon: "" });
  const bp = window.backpack;
  if (bp && (bp.isBackpack || typeof bp.connect === "function")) out.push({ id: "backpack", name: "Backpack", kind: "injected", raw: bp, icon: "" });
  return out;
}

function standard() {
  const out = [];
  try {
    const reg = window.navigator && window.navigator.wallets;
    if (!reg) return out;
    const list = typeof reg.get === "function" ? reg.get() : Array.isArray(reg) ? reg : [];
    for (const w of list) {
      if (!w || !w.features || !w.features["standard:connect"] || !w.features["solana:signTransaction"]) continue;
      const chains = Array.isArray(w.chains) ? w.chains : [];
      if (chains.length && !chains.some((c) => String(c).startsWith("solana:"))) continue;
      const id = "std:" + String(w.name || "wallet").toLowerCase();
      out.push({ id, name: String(w.name || "Wallet").slice(0, 40), kind: "standard", raw: w, icon: typeof w.icon === "string" && w.icon.startsWith("data:image/") ? w.icon : "" });
    }
  } catch (_) {}
  return out;
}

/// Every wallet this browser offers, injected ones first, no duplicates by name.
export function available() {
  const seen = new Set();
  const all = [];
  for (const w of [...injected(), ...standard()]) {
    const key = w.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(w);
  }
  return all;
}

// ---- connect / disconnect -------------------------------------------------------------------

function toPubkey(PublicKey, v) {
  if (!v) return null;
  if (typeof v.toBase58 === "function") return new PublicKey(v.toBase58());
  if (v.address) return new PublicKey(v.address);
  if (v.publicKey) return new PublicKey(v.publicKey);
  return new PublicKey(v);
}

export async function connect(entry, PublicKey, opts = {}) {
  const silent = !!opts.silent;
  try {
    if (entry.kind === "standard") {
      const res = await entry.raw.features["standard:connect"].connect(silent ? { silent: true } : undefined);
      const acc = res && res.accounts && res.accounts[0];
      if (!acc) throw new Error("The wallet returned no account.");
      W.account = acc;
      W.publicKey = new PublicKey(acc.address);
    } else {
      const res = await entry.raw.connect(silent ? { onlyIfTrusted: true } : undefined);
      const pk = (res && res.publicKey) || entry.raw.publicKey;
      if (!pk) throw new Error("The wallet returned no account.");
      W.account = null;
      W.publicKey = toPubkey(PublicKey, pk);
    }
    W.name = entry.name; W.kind = entry.kind; W.raw = entry.raw; W.id = entry.id;
    try { localStorage.setItem(STORE, entry.id); } catch (_) {}
    listen(entry, PublicKey);
    emit();
    return W;
  } catch (e) {
    if (silent) return null;
    throw new Error(explain(e));
  }
}

function listen(entry, PublicKey) {
  const raw = entry.raw;
  if (entry.kind === "standard") {
    const ev = raw.features["standard:events"];
    if (ev && typeof ev.on === "function") {
      try {
        ev.on("change", (props) => {
          const acc = props && props.accounts && props.accounts[0];
          if (!acc) { clear(); return; }
          W.account = acc; W.publicKey = new PublicKey(acc.address); emit();
        });
      } catch (_) {}
    }
    return;
  }
  if (typeof raw.on !== "function") return;
  try {
    raw.on("accountChanged", (pk) => { if (!pk) { clear(); return; } W.publicKey = toPubkey(PublicKey, pk); emit(); });
    raw.on("disconnect", () => clear());
  } catch (_) {}
}

function clear() {
  W.name = ""; W.publicKey = null; W.kind = ""; W.raw = null; W.account = null; W.id = "";
  try { localStorage.removeItem(STORE); } catch (_) {}
  emit();
}

export async function disconnect() {
  const raw = W.raw;
  const kind = W.kind;
  clear();
  try {
    if (!raw) return;
    if (kind === "standard") { const d = raw.features["standard:disconnect"]; if (d) await d.disconnect(); }
    else if (typeof raw.disconnect === "function") await raw.disconnect();
  } catch (_) {}
}

/// Reconnect the remembered wallet without a prompt, when the wallet allows it.
export async function restore(PublicKey) {
  let id = "";
  try { id = localStorage.getItem(STORE) || ""; } catch (_) {}
  if (!id) return null;
  const entry = available().find((w) => w.id === id);
  if (!entry) return null;
  return connect(entry, PublicKey, { silent: true });
}

// ---- signing --------------------------------------------------------------------------------

/// Signs a VersionedTransaction and returns it signed (same object type).
export async function signTransaction(tx, VersionedTransaction) {
  if (!W.raw) throw new Error("Connect a wallet first.");
  try {
    if (W.kind === "standard") {
      const f = W.raw.features["solana:signTransaction"];
      const out = await f.signTransaction({ transaction: tx.serialize(), account: W.account });
      const bytes = out && out[0] && out[0].signedTransaction;
      if (!bytes) throw new Error("The wallet returned no signature.");
      return VersionedTransaction.deserialize(bytes);
    }
    const signed = await W.raw.signTransaction(tx);
    return signed;
  } catch (e) { throw new Error(explain(e)); }
}

/// Lets the wallet send when it can; falls back to sign here, send by the caller.
export async function signAndSendTransaction(tx, VersionedTransaction, send) {
  if (!W.raw) throw new Error("Connect a wallet first.");
  if (W.kind === "injected" && typeof W.raw.signAndSendTransaction === "function") {
    try {
      const res = await W.raw.signAndSendTransaction(tx);
      const sig = typeof res === "string" ? res : res && res.signature;
      if (sig) return sig;
    } catch (e) { throw new Error(explain(e)); }
  }
  const signed = await signTransaction(tx, VersionedTransaction);
  return send(signed);
}

/// True when the connected wallet can sign several transactions in one prompt.
export function canSignAll() {
  if (!W.raw) return false;
  if (W.kind === "standard") return !!W.raw.features["solana:signTransaction"];
  return typeof W.raw.signAllTransactions === "function";
}

/// Signs every transaction in one wallet prompt and returns them signed, in order.
export async function signAllTransactions(txs, VersionedTransaction) {
  if (!W.raw) throw new Error("Connect a wallet first.");
  try {
    if (W.kind === "standard") {
      const f = W.raw.features["solana:signTransaction"];
      const out = await f.signTransaction(...txs.map((tx) => ({ transaction: tx.serialize(), account: W.account })));
      return out.map((o) => VersionedTransaction.deserialize(o.signedTransaction));
    }
    return await W.raw.signAllTransactions(txs);
  } catch (e) { throw new Error(explain(e)); }
}

/// Signs a message (bytes) and returns the raw 64-byte ed25519 signature. The storage of a
/// collectible's art asks for one per upload; it is never a transaction.
export async function signMessage(bytes) {
  if (!W.raw) throw new Error("Connect a wallet first.");
  try {
    let sig;
    if (W.kind === "standard") {
      const f = W.raw.features["solana:signMessage"];
      if (!f) throw new Error("This wallet cannot sign a message. Use a wallet that can, such as Phantom.");
      const out = await f.signMessage({ message: bytes, account: W.account });
      sig = out && out[0] && out[0].signature;
    } else {
      if (typeof W.raw.signMessage !== "function") throw new Error("This wallet cannot sign a message. Use a wallet that can, such as Phantom.");
      const r = await W.raw.signMessage(bytes, "utf8");
      sig = r && r.signature ? r.signature : r;
    }
    sig = sig instanceof Uint8Array ? sig : sig && sig.data ? Uint8Array.from(sig.data) : sig ? Uint8Array.from(sig) : null;
    if (!sig || sig.length !== 64) throw new Error("The wallet returned no signature.");
    return sig;
  } catch (e) { throw new Error(explain(e)); }
}

/// One plain sentence for a wallet failure.
export function explain(e) {
  const msg = String((e && (e.message || e.error && e.error.message)) || e || "");
  const code = e && (e.code || (e.error && e.error.code));
  if (code === 4001 || /reject|declin|cancel|denied/i.test(msg)) return "You closed the wallet prompt, so nothing was sent.";
  if (/not connected|disconnected/i.test(msg)) return "The wallet is not connected. Connect it and try again.";
  if (/unauthori|trusted/i.test(msg)) return "The wallet did not allow the connection. Open it and approve this site.";
  if (/network|cluster|rpc/i.test(msg)) return "The wallet is on another network. Switch it to the cluster shown in the top bar.";
  if (msg) return msg.length > 160 ? msg.slice(0, 157) + "..." : msg;
  return "It did not go through. Try again.";
}
