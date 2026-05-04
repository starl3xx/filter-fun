/// Parity battery for `weiToDecimalEther` (Bugbot PR #101 follow-up).
///
/// The same function lives in both packages:
///   - `packages/indexer/src/api/builders.ts`  (consumed server-side)
///   - `packages/web/src/lib/arena/format.ts`  (consumed client-side)
///
/// They must produce byte-for-byte identical output — both surfaces in the
/// "single source of truth" loop (admin holdings panel + filter-moment recap)
/// derive their displayed projection string from this helper. The original
/// page.tsx implementation truncated where the indexer rounds, breaking the
/// guarantee for wei values whose 7th decimal digit is ≥ 5.
///
/// This test pins a battery of (wei, expectedString) pairs. The IDENTICAL
/// battery lives in `packages/indexer/test/api/security/weiToDecimalEtherParity.test.ts`.
/// If you change either implementation's behaviour, BOTH workspaces' CI fails
/// until the batteries are re-aligned — automated divergence detection
/// without introducing a shared package.

import {describe, expect, it} from "vitest";

import {weiToDecimalEther} from "@/lib/arena/format";

/// MUST stay in sync with the indexer-side battery. Includes:
///   - exact zero
///   - whole-eth (no fractional part)
///   - sub-wei boundaries (1 wei → "0.000000")
///   - 7th-decimal rounding boundary (the case bugbot caught)
///   - rollover-into-next-whole boundary (0.999999500… → "1")
///   - large value (preserves whole digits)
///   - negative
const PARITY_CASES: ReadonlyArray<readonly [bigint, string]> = [
  [0n, "0"],
  [1n, "0"],                                                  // sub-µeth → rounds to 0 (frac6 < halfScale)
  [500_000_000_000n, "0.000001"],                             // 5e11 wei = 0.0000005 ETH → rounds up to 0.000001
  [499_999_999_999n, "0"],                                    // just below boundary → rounds to 0
  [10n ** 18n, "1"],                                          // 1 ETH exact
  [2n * 10n ** 18n, "2"],                                     // 2 ETH exact
  [1_234_567_000_000_000_000n, "1.234567"],                   // exact 6-decimal value
  [1_234_564_800_000_000_000n, "1.234565"],                   // 7th digit = 8 → rounds UP (truncation would give 1.234564)
  [1_234_564_499_999_999_999n, "1.234564"],                   // 7th digit = 4 → rounds DOWN
  [999_999_500_000_000_000n, "1"],                            // rollover into next whole unit
  [4_600_000_000_000_000n, "0.0046"],                         // small fraction (the original cross-link fixture)
  [(-1n) * 10n ** 18n, "-1"],                                 // negative whole ETH
  [(-1_234_564_800_000_000_000n), "-1.234565"],               // negative + rounding
];

describe("weiToDecimalEther — parity battery (web)", () => {
  it.each(PARITY_CASES)("wei = %s → %s", (wei, expected) => {
    expect(weiToDecimalEther(wei)).toBe(expected);
  });
});
