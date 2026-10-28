// Client-side resolver for a hook's ExtraAccountMetaList (the Token-2022 transfer-hook
// TLV format, keyed by our callback discriminator). Mirrors spl-tlv-account-resolution.
import { AccountMeta, Connection, PublicKey } from "@solana/web3.js";
import { CALLBACK_TLV_DISC } from "./generated.js";

export interface ExtraAccountMetaRaw {
  discriminator: number;
  addressConfig: Uint8Array;
  isSigner: boolean;
  isWritable: boolean;
}

/// Parse the TLV account into raw entries.
export function parseExtraAccountMetas(data: Uint8Array): ExtraAccountMetaRaw[] {
  let off = 0;
  const view = () => new DataView(data.buffer, data.byteOffset, data.byteLength);
  while (off + 12 <= data.length) {
    const disc = data.subarray(off, off + 8);
    const len = view().getUint32(off + 8, true);
    const valueStart = off + 12;
    const matches = CALLBACK_TLV_DISC.every((b, i) => disc[i] === b);
    if (matches) {
      const count = view().getUint32(valueStart, true);
      const out: ExtraAccountMetaRaw[] = [];
      let p = valueStart + 4;
      for (let i = 0; i < count; i++) {
        out.push({
          discriminator: data[p],
          addressConfig: data.subarray(p + 1, p + 33),
          isSigner: data[p + 33] !== 0,
          isWritable: data[p + 34] !== 0,
        });
        p += 35;
      }
      return out;
    }
    if (len === 0 && disc.every((b) => b === 0)) break;
    off = valueStart + len;
  }
  return [];
}

type Seed =
  | { kind: "literal"; bytes: Uint8Array }
  | { kind: "instructionData"; index: number; length: number }
  | { kind: "accountKey"; index: number }
  | { kind: "accountData"; accountIndex: number; dataIndex: number; length: number };

function unpackSeeds(cfg: Uint8Array): Seed[] {
  const seeds: Seed[] = [];
  let i = 0;
  while (i < cfg.length) {
    const t = cfg[i];
    if (t === 0) break;
    if (t === 1) { const n = cfg[i + 1]; seeds.push({ kind: "literal", bytes: cfg.subarray(i + 2, i + 2 + n) }); i += 2 + n; }
    else if (t === 2) { seeds.push({ kind: "instructionData", index: cfg[i + 1], length: cfg[i + 2] }); i += 3; }
    else if (t === 3) { seeds.push({ kind: "accountKey", index: cfg[i + 1] }); i += 2; }
    else if (t === 4) { seeds.push({ kind: "accountData", accountIndex: cfg[i + 1], dataIndex: cfg[i + 2], length: cfg[i + 3] }); i += 4; }
    else throw new Error(`unknown seed type ${t}`);
  }
  return seeds;
}

/// Resolve the hook's extra accounts for a callback.
/// `fixed` = the five fixed callback accounts (pool, caller, user, quote mint, base mint).
/// `instructionData` = the callback data the pool will send (discriminator + payload); only
/// needed when a hook derives seeds from instruction data, which our templates do not.
export async function resolveExtraAccounts(
  connection: Connection,
  hookProgram: PublicKey,
  extraMetasData: Uint8Array,
  fixed: PublicKey[],
  instructionData: Uint8Array = new Uint8Array(0),
): Promise<AccountMeta[]> {
  const raw = parseExtraAccountMetas(extraMetasData);
  const resolved: AccountMeta[] = [];
  const allKeys = () => [...fixed, ...resolved.map((m) => m.pubkey)];
  const accountData = async (idx: number): Promise<Uint8Array> => {
    const key = allKeys()[idx];
    if (!key) throw new Error(`seed refers to account ${idx} which does not exist yet`);
    const info = await connection.getAccountInfo(key);
    if (!info) throw new Error(`account ${key.toBase58()} needed for a seed does not exist`);
    return new Uint8Array(info.data);
  };
  for (const m of raw) {
    let pubkey: PublicKey;
    if (m.discriminator === 0) {
      pubkey = new PublicKey(m.addressConfig);
    } else {
      const program = m.discriminator === 1 ? hookProgram : allKeys()[m.discriminator - 128];
      if (!program) throw new Error("external PDA program index out of range");
      const seedBufs: Buffer[] = [];
      for (const s of unpackSeeds(m.addressConfig)) {
        if (s.kind === "literal") seedBufs.push(Buffer.from(s.bytes));
        else if (s.kind === "instructionData") seedBufs.push(Buffer.from(instructionData.subarray(s.index, s.index + s.length)));
        else if (s.kind === "accountKey") {
          const k = allKeys()[s.index];
          if (!k) throw new Error(`seed refers to account ${s.index} which does not exist yet`);
          seedBufs.push(k.toBuffer());
        } else {
          const d = await accountData(s.accountIndex);
          seedBufs.push(Buffer.from(d.subarray(s.dataIndex, s.dataIndex + s.length)));
        }
      }
      pubkey = PublicKey.findProgramAddressSync(seedBufs, program)[0];
    }
    // The pool never passes an extra account to a hook as a signer, whatever the list says.
    // Copying the bit would only make a swap nobody can sign.
    resolved.push({ pubkey, isSigner: false, isWritable: m.isWritable });
  }
  return resolved;
}
