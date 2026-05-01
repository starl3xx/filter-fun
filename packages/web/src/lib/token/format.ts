/// Formatting helpers scoped to the admin console. Distinct from
/// `lib/arena/format.ts` which is keyed to the arena's display contracts.

import {formatEther} from "viem";

/// Ξ-prefixed display of a wei value, with up to 4 decimal places. Trailing
/// zeros are stripped; values < 0.0001 ETH show a leading "<".
export function fmtEthShort(wei: bigint): string {
  if (wei === 0n) return "Ξ0";
  const raw = formatEther(wei);
  const num = Number(raw);
  if (num < 0.0001) return "<Ξ0.0001";
  // Trim trailing zeros and a hanging decimal.
  const trimmed = num.toFixed(4).replace(/\.?0+$/, "");
  return `Ξ${trimmed}`;
}

/// Address shortening — `0xabcd…1234`. Mirrors the broadcast TopBar's pattern.
export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/// Case-insensitive address equality. Wagmi's `useAccount().address` is
/// checksummed, contract reads return checksummed too, but routes can deliver
/// lowercase; comparing as strings without normalising flakes on case.
export function addrEq(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/// Whether `addr` is the zero address (or null). Treats malformed strings as
/// non-zero — those should fail elsewhere (e.g. viem's isAddress).
export function isZeroAddress(addr: string | null | undefined): boolean {
  if (!addr) return true;
  return addr.toLowerCase() === "0x0000000000000000000000000000000000000000";
}
