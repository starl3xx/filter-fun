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
/// battery lives in `packages/web/test/regression/weiToDecimalEtherParity.test.ts`.
/// If you change either implementation's behaviour, BOTH workspaces' CI fails
/// until the batteries are re-aligned — automated divergence detection
/// without introducing a shared package.

import {describe, expect, it} from "vitest";

import {weiToDecimalEther} from "../../../src/api/builders.js";

/// MUST stay in sync with the web-side battery.
const PARITY_CASES: ReadonlyArray<readonly [bigint, string]> = [
  [0n, "0"],
  [1n, "0"],
  [500_000_000_000n, "0.000001"],
  [499_999_999_999n, "0"],
  [10n ** 18n, "1"],
  [2n * 10n ** 18n, "2"],
  [1_234_567_000_000_000_000n, "1.234567"],
  [1_234_564_800_000_000_000n, "1.234565"],
  [1_234_564_499_999_999_999n, "1.234564"],
  [999_999_500_000_000_000n, "1"],
  [4_600_000_000_000_000n, "0.0046"],
  [(-1n) * 10n ** 18n, "-1"],
  [(-1_234_564_800_000_000_000n), "-1.234565"],
];

describe("weiToDecimalEther — parity battery (indexer)", () => {
  it.each(PARITY_CASES)("wei = %s → %s", (wei, expected) => {
    expect(weiToDecimalEther(wei)).toBe(expected);
  });
});
