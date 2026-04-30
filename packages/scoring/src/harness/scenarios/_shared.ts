import type {Address} from "../../types.js";

/// 1 WETH in raw units. Re-exported here so scenario authors don't have to
/// reach into the test files for the same constant.
export const WETH = 1_000_000_000_000_000_000n;

/// Deterministic 20-byte hex address from an integer. Scenario authors
/// pick stable IDs (1, 2, 3, ...) for tokens and wallets so output diffs
/// remain readable.
export function addressOf(n: number): Address {
  return `0x${n.toString(16).padStart(40, "0")}` as Address;
}

/// Produce N wallet addresses from a base offset. The offset keeps wallet
/// IDs from colliding with token IDs in the same scenario (tokens use
/// 0x..a, 0x..b, 0x..c; wallets start at 0x..0001).
export function walletRange(n: number, offset = 1): Address[] {
  const out: Address[] = [];
  for (let i = 0; i < n; i++) out.push(addressOf(offset + i));
  return out;
}
