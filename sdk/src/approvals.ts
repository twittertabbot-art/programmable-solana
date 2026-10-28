// The approved list (HOOKS.md section 6.1). While the platform's rule is on, a hook that is
// not the platform's own opens a pool only once Programmable has put its program on the list.
// The list sits in the Platform account after its fixed part:
//   byte 405            the rule (1 = on)
//   bytes 451..455      u32 little endian: how many programs
//   then                32 bytes per program, in no particular order
// A platform account of 451 bytes has no list.
import { PublicKey } from "@solana/web3.js";
import { PROGRAMS, SYSTEM_PROGRAM } from "./constants.js";

/// Where the list starts: the Platform account's discriminator and fixed fields.
export const APPROVED_LIST_OFFSET = 451;
/// The byte of the rule, `Platform::hook_approval_required`.
export const APPROVAL_RULE_OFFSET = 405;
/// The most programs the list can hold.
export const MAX_APPROVED_HOOKS = 256;

export interface ApprovalErrorInfo { number: number; name: string; message: string }

/// The pool program's errors of the approved list, by number.
export const APPROVAL_ERRORS: Readonly<Record<number, ApprovalErrorInfo>> = {
  6052: { number: 6052, name: "HookNotApproved", message: "this hook program is not on the platform's approved list" },
  6053: { number: 6053, name: "HookAlreadyApproved", message: "this hook program is already on the approved list" },
  6054: { number: 6054, name: "HookApprovalNotNeeded", message: "the platform's own hooks need no approval: only a frozen hook can be approved" },
  6055: { number: 6055, name: "TooManyApprovedHooks", message: "the approved list is full" },
  6056: { number: 6056, name: "ApprovedListCorrupt", message: "the approved list after the platform account cannot be read" },
};

/// What the SDK throws, before anything is built, for a pool the program would refuse with
/// `HookNotApproved` (6052).
export class HookApprovalRefusal extends Error {
  constructor(public readonly info: ApprovalErrorInfo, public readonly program: PublicKey) {
    super(`${info.message}: ${program.toBase58()} has not been reviewed and approved by Programmable yet, so no pool can open on it`);
    this.name = "HookApprovalRefusal";
  }
  get code(): string { return this.info.name; }
  get number(): number { return this.info.number; }
}

/// The programs on the list, read from the raw Platform account data. `corrupt` is true when a
/// count is there that the account cannot hold: the program then refuses every pool that needs
/// the list, so a client must not read it as an empty list that lets everything through.
export function decodeApprovedList(data: Uint8Array): { programs: PublicKey[]; corrupt: boolean } {
  if (data.length <= APPROVED_LIST_OFFSET) return { programs: [], corrupt: false };
  if (data.length < APPROVED_LIST_OFFSET + 4) return { programs: [], corrupt: true };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = view.getUint32(APPROVED_LIST_OFFSET, true);
  if (n > MAX_APPROVED_HOOKS || data.length < APPROVED_LIST_OFFSET + 4 + 32 * n) return { programs: [], corrupt: true };
  const programs: PublicKey[] = [];
  for (let i = 0; i < n; i++) {
    const o = APPROVED_LIST_OFFSET + 4 + 32 * i;
    programs.push(new PublicKey(data.subarray(o, o + 32)));
  }
  return { programs, corrupt: false };
}

/// The platform's own template programs: they need no approval.
export function isTemplateProgram(program: PublicKey): boolean {
  return [PROGRAMS.hook_tax, PROGRAMS.hook_launch_guard, PROGRAMS.hook_buyback, PROGRAMS.hook_collectible, PROGRAMS.hook_rules].some((p) => p.equals(program));
}

/// Where a hook stands with the approved list.
/// - `required`: the platform's rule is on.
/// - `approved`: the program is on the list.
/// - `own`: no hook at all, or one of the platform's own hooks (a template, or a program whose
///   upgrade authority the platform whitelists): these never need approval.
/// - `allowed`: a pool can open on it now (`own || approved || !required`), and the list can be
///   read (`listCorrupt` false) when the rule needs it.
export interface HookApproval { required: boolean; approved: boolean; own: boolean; allowed: boolean; listCorrupt: boolean }

export function hookApprovalOf(
  platform: { hookApprovalRequired: boolean; approvedHooks: PublicKey[]; approvedListCorrupt?: boolean },
  program: PublicKey,
  own: boolean,
): HookApproval {
  const none = program.equals(SYSTEM_PROGRAM) || program.equals(PublicKey.default);
  const isOwn = none || own || isTemplateProgram(program);
  const approved = platform.approvedHooks.some((p) => p.equals(program));
  const listCorrupt = !!platform.approvedListCorrupt;
  const required = platform.hookApprovalRequired;
  const allowed = isOwn || !required || (approved && !listCorrupt);
  return { required, approved, own: isOwn, allowed, listCorrupt };
}

/// The approved-list error a failed transaction names in its logs: Anchor's "Error Code:
/// HookNotApproved. Error Number: 6052" line, or the raw "custom program error: 0x17a4". null
/// for anything else.
export function approvalErrorFromLogs(logs: readonly string[]): ApprovalErrorInfo | null {
  const text = logs.join("\n");
  const named = /Error Code: (\w+)\. Error Number: (\d+)/.exec(text);
  if (named) {
    const info = APPROVAL_ERRORS[Number(named[2])];
    return info && info.name === named[1] ? info : null;
  }
  const raw = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (raw) return APPROVAL_ERRORS[parseInt(raw[1], 16)] ?? null;
  return null;
}
