// Minimal borsh: exactly the shapes our programs use. No schema objects, no reflection.
import { PublicKey } from "@solana/web3.js";

export class Writer {
  private chunks: Uint8Array[] = [];
  u8(v: number) { this.chunks.push(Uint8Array.of(v & 0xff)); return this; }
  bool(v: boolean) { return this.u8(v ? 1 : 0); }
  u16(v: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.chunks.push(b); return this; }
  u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.chunks.push(b); return this; }
  u64(v: bigint | number) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); this.chunks.push(b); return this; }
  i64(v: bigint | number) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), true); this.chunks.push(b); return this; }
  pubkey(k: PublicKey) { this.chunks.push(k.toBytes()); return this; }
  bytes(b: Uint8Array) { this.chunks.push(b); return this; }
  string(s: string) { const enc = new TextEncoder().encode(s); this.u32(enc.length); this.chunks.push(enc); return this; }
  option<T>(v: T | null | undefined, write: (w: Writer, v: T) => void) { if (v === null || v === undefined) return this.u8(0); this.u8(1); write(this, v); return this; }
  vecPubkeys(keys: PublicKey[]) { this.u32(keys.length); for (const k of keys) this.pubkey(k); return this; }
  toBytes(): Uint8Array {
    const len = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  toBuffer(): Buffer { return Buffer.from(this.toBytes()); }
}

export class Reader {
  off = 0;
  constructor(public readonly data: Uint8Array) {}
  private view() { return new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength); }
  skip(n: number) { this.off += n; return this; }
  u8() { return this.data[this.off++]; }
  bool() { return this.u8() !== 0; }
  u16() { const v = this.view().getUint16(this.off, true); this.off += 2; return v; }
  u32() { const v = this.view().getUint32(this.off, true); this.off += 4; return v; }
  u64() { const v = this.view().getBigUint64(this.off, true); this.off += 8; return v; }
  i64() { const v = this.view().getBigInt64(this.off, true); this.off += 8; return v; }
  u128() { const lo = this.u64(); const hi = this.u64(); return (hi << 64n) | lo; }
  pubkey() { const k = new PublicKey(this.data.subarray(this.off, this.off + 32)); this.off += 32; return k; }
  bytes(n: number) { const b = this.data.subarray(this.off, this.off + n); this.off += n; return b; }
  string() { const n = this.u32(); return new TextDecoder().decode(this.bytes(n)); }
  option<T>(read: (r: Reader) => T): T | null { return this.u8() === 0 ? null : read(this); }
  fixedString(n: number) { return new TextDecoder().decode(this.bytes(n)).replace(/\0+$/, ""); }
  remaining() { return this.data.length - this.off; }
}

export function discriminatorMatches(data: Uint8Array, disc: number[]): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) if (data[i] !== disc[i]) return false;
  return true;
}

export function concat(...parts: Uint8Array[]): Buffer {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return Buffer.from(out);
}
