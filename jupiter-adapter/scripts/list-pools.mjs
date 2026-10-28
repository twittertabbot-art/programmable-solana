// Lists the pools of a cluster by kind, with what a parity test needs to know about each.
//   node jupiter-adapter/scripts/list-pools.mjs [rpc url]
import { Connection } from "@solana/web3.js";
import { HookpoolClient, PROGRAMS, TOKEN_2022_PROGRAM, curveStateName } from "../../sdk/dist/index.js";

const conn = new Connection(process.argv[2] || "http://127.0.0.1:8899", "confirmed");
const client = new HookpoolClient(conn);
const names = new Map([
  [PROGRAMS.hook_tax.toBase58(), "tax"], [PROGRAMS.hook_launch_guard.toBase58(), "launch_guard"], [PROGRAMS.hook_buyback.toBase58(), "buyback"],
  [PROGRAMS.hook_collectible.toBase58(), "collectible"], [PROGRAMS.hook_rules.toBase58(), "rules"],
]);
const slot = await conn.getSlot("confirmed");
const pools = await client.allPools();
console.log("slot", slot, "pools", pools.length);
for (const p of pools) {
  const kind = !p.hasHook ? "none" : names.get(p.hookProgram.toBase58()) || "custom";
  const t22 = p.baseTokenProgram.equals(TOKEN_2022_PROGRAM);
  let extra = "";
  if (kind === "launch_guard") {
    const info = await client.hookInfo(p).catch(() => null);
    if (info && info.guard) extra = ` guard start ${info.guard.startSlot} slots ${info.guard.guardSlots} startFee ${info.guard.startFeeBps} running ${BigInt(slot) < info.guard.startSlot + info.guard.guardSlots}`;
  }
  if (kind === "rules") {
    const info = await client.hookInfo(p).catch(() => null);
    const r = info && info.rules;
    if (r) {
      const sum = (s) => s.creatorBps + s.holdersBps + s.burnBps;
      extra = ` rules buy ${sum(r.buy)} sell ${sum(r.sell)} bps`
        + (r.sniperSlots > 0n ? ` sniper start ${r.startSlot} slots ${r.sniperSlots} startFee ${r.sniperStartFeeBps} running ${BigInt(slot) < r.startSlot + r.sniperSlots}` : "")
        + (r.maxBuyQuote > 0n ? ` limit ${r.maxBuyQuote} slots ${r.limitSlots} running ${BigInt(slot) < r.startSlot + r.limitSlots}` : "");
    }
  }
  // a pool launched on the curve: its state, the virtual quote in its price, its target (rq is the real quote)
  if (p.curveState !== 0) extra += ` curve ${curveStateName(p.curveState)} virtual ${p.virtualQuote} target ${p.graduationTarget}`;
  console.log([kind.padEnd(12), t22 ? "t22 " : "spl ", p.address.toBase58(), "base", p.baseMint.toBase58(), "rb", p.reserveBase, "rq", p.reserveQuote, "fee", p.lpFeeBps, "flags", p.hookFlags, "created", p.createdSlot].join(" ") + extra);
}
