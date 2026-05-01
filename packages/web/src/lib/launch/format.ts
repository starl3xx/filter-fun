/// Launch-page formatters. The launch flow works in wei (the contract's
/// `nextLaunchCost` is wei), but `lib/arena/format`'s `fmtEth` takes
/// decimal-ETH strings — so we add a wei-aware variant here. Consumers
/// that need the decimal-ETH form import `fmtEth` directly from the
/// arena module.

import {formatEther} from "viem";

/// "Ξ0.05" from a wei BigInt. Three decimals — slot-cost increments are
/// small enough that two decimals collapses adjacent slots to identical
/// labels. Empty / non-finite input renders as "Ξ —".
export function fmtEthFromWei(wei: bigint | null | undefined): string {
  if (wei === null || wei === undefined) return "Ξ —";
  return `Ξ${Number(formatEther(wei)).toFixed(3)}`;
}

/// Truncate an address for display: 0x4a2…7c1.
export function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
