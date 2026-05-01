/// Launch-page formatters — built on top of `lib/arena/format` so the
/// Ξ-prefixed numbers stay consistent across pages.
///
/// The launch flow works in wei (the contract's `nextLaunchCost` is wei),
/// but the arena formatter takes decimal-ETH strings — so we convert here
/// rather than in every component.

import {formatEther} from "viem";

import {fmtEth} from "@/lib/arena/format";

/// "Ξ0.05" from a wei BigInt. Three decimals — slot-cost increments are
/// small enough that two decimals collapses adjacent slots to identical
/// labels. Empty / non-finite input renders as "Ξ0.000".
export function fmtEthFromWei(wei: bigint | null | undefined): string {
  if (wei === null || wei === undefined) return "Ξ —";
  return `Ξ${Number(formatEther(wei)).toFixed(3)}`;
}

export {fmtEth};

/// Truncate an address for display: 0x4a2…7c1.
export function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
