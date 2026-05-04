/// Unit tests for the calculator math (lib/launch/economics).
///
/// The math here is the canonical source of truth for the cost/ROI panel —
/// it's worth pinning the formulas to specific outputs so a careless tweak
/// to one constant doesn't silently mis-bill creators.

import {parseEther} from "viem";
import {describe, expect, it} from "vitest";

import {
  BASE_LAUNCH_COST_WEI,
  CHAMPION_BOUNTY_BPS,
  CREATOR_FEE_BPS,
  ETH_USD_FALLBACK,
  MAX_LAUNCHES,
  PEAK_MC_SCALE,
  POL_SLICE_BPS,
  PRESETS,
  WEEKLY_VOLUME_SCALE,
  calculateOutcomes,
  fmtUsd,
  fmtUsdSigned,
  logToValue,
  slotCostWei,
  valueToLog,
  weiToUsd,
} from "@/lib/launch/economics";

describe("constants — spec §45 / §10 / §11", () => {
  it("BASE_LAUNCH_COST is 0.01 ETH (5× reduced 2026-05-02)", () => {
    expect(BASE_LAUNCH_COST_WEI).toBe(parseEther("0.01"));
  });
  it("creator fee = 20 bps, bounty = 250 bps, POL = 1000 bps", () => {
    expect(CREATOR_FEE_BPS).toBe(20);
    expect(CHAMPION_BOUNTY_BPS).toBe(250);
    expect(POL_SLICE_BPS).toBe(1000);
  });
  it("MAX_LAUNCHES is 12", () => {
    expect(MAX_LAUNCHES).toBe(12);
  });
});

describe("slotCostWei — spec §4.3 quadratic curve", () => {
  it("slot 1 (index 0) is base cost", () => {
    expect(slotCostWei(0)).toBe(parseEther("0.01"));
  });
  it("slot 12 (index 11) is BASE * (1 + 121/144) ≈ 1.840 × base", () => {
    const expected = (parseEther("0.01") * 1840n) / 1000n;
    // Allow a tiny rounding band — the implementation uses 6-digit fixed-point.
    const actual = slotCostWei(11);
    const drift = actual > expected ? actual - expected : expected - actual;
    expect(drift).toBeLessThan(parseEther("0.00001"));
  });
  it("slot 6 (index 5) is BASE * (1 + 25/144) ≈ 1.174 × base", () => {
    const expected = (parseEther("0.01") * 1173611n) / 1_000_000n; // 1 + 25/144
    const actual = slotCostWei(5);
    const drift = actual > expected ? actual - expected : expected - actual;
    expect(drift).toBeLessThan(parseEther("0.00001"));
  });
});

describe("USD helpers", () => {
  it("weiToUsd uses the fallback when no rate supplied", () => {
    // 0.01 ETH × $3500 = $35
    expect(weiToUsd(parseEther("0.01"))).toBeCloseTo(35, 5);
  });
  it("weiToUsd respects a custom rate", () => {
    expect(weiToUsd(parseEther("1"), 5000)).toBe(5000);
  });
  it("ETH_USD_FALLBACK is the documented $3500", () => {
    expect(ETH_USD_FALLBACK).toBe(3500);
  });
  it("fmtUsd: small numbers exact, big numbers compact", () => {
    expect(fmtUsd(35)).toBe("$35");
    expect(fmtUsd(1_234)).toBe("$1,234");
    expect(fmtUsd(50_000)).toBe("$50k");
    expect(fmtUsd(2_500_000)).toBe("$2.50M");
  });
  it("fmtUsd: million-boundary rounding never produces '$1000k'", () => {
    // Regression: bugbot caught that values $999,500–$999,999 rounded to
    // "$1000k" via the k-branch's .toFixed(0). The M-branch threshold is
    // now 999.5k so those values escalate to "$1.00M".
    expect(fmtUsd(999_499)).toBe("$999k");
    expect(fmtUsd(999_500)).toBe("$1.00M");
    expect(fmtUsd(999_999)).toBe("$1.00M");
    expect(fmtUsd(1_000_000)).toBe("$1.00M");
    expect(fmtUsd(-999_999)).toBe("$-1.00M");
  });
  it("fmtUsdSigned: sign always rendered", () => {
    expect(fmtUsdSigned(120)).toBe("+$120");
    expect(fmtUsdSigned(-45)).toBe("−$45");
    expect(fmtUsdSigned(0)).toBe("$0");
  });
});

describe("log slider scale", () => {
  it("round-trips slider t → value → t", () => {
    for (const t of [0, 25, 50, 75, 100]) {
      const v = logToValue(t, PEAK_MC_SCALE);
      const back = valueToLog(v, PEAK_MC_SCALE);
      expect(back).toBeCloseTo(t, 5);
    }
  });
  it("logToValue covers the full $1k → $10M range for peak MC", () => {
    expect(logToValue(0, PEAK_MC_SCALE)).toBeCloseTo(1_000, 1);
    expect(logToValue(100, PEAK_MC_SCALE)).toBeCloseTo(10_000_000, 1);
  });
  it("logToValue covers the full $1k → $10M range for weekly volume", () => {
    expect(logToValue(0, WEEKLY_VOLUME_SCALE)).toBeCloseTo(1_000, 1);
    expect(logToValue(100, WEEKLY_VOLUME_SCALE)).toBeCloseTo(10_000_000, 1);
  });
  it("viral preset's volume falls within the slider scale (no clamp)", () => {
    // Regression: bugbot caught a high-sev where the viral preset's
    // weeklyVolumeUsd ($10M) exceeded WEEKLY_VOLUME_SCALE.max ($5M),
    // which silently halved creator-fees on the first slider touch.
    const viral = PRESETS.find((p) => p.id === "viral")!;
    expect(viral.weeklyVolumeUsd).toBeLessThanOrEqual(WEEKLY_VOLUME_SCALE.max);
  });
  it("clamps values outside the configured range", () => {
    // Slider t < 0 clamps to 0 (= scale.min); t > 100 clamps to scale.max.
    expect(logToValue(-50, PEAK_MC_SCALE)).toBeCloseTo(1_000, 1);
    expect(logToValue(150, PEAK_MC_SCALE)).toBeCloseTo(10_000_000, 1);
  });
});

describe("calculateOutcomes — spec §45.3 formulas", () => {
  const baseInput = {
    slotCostWei: parseEther("0.01"),
    stakeWei: parseEther("0.01"),
    ethUsd: 3500,
    peakMcUsd: 50_000,
    weeklyVolumeUsd: 100_000,
  };

  it("filtered: half-week of fees, stake forfeited, no bounty", () => {
    const out = calculateOutcomes({...baseInput, outcome: "filtered"});
    // Half-week of fees: $100k * 0.0020 * 0.5 = $100
    expect(out.creatorFeesUsd).toBeCloseTo(100, 5);
    // Net = slot ($35) + stake ($35) - $100 = -$30 (creator earned more in fees)
    expect(out.netUsd).toBeCloseTo(-30, 5);
    expect(out.bountyRangeUsd).toBeNull();
    expect(out.polBackingEth).toBeNull();
  });

  it("survives: full-week fees, stake refunded, no bounty", () => {
    const out = calculateOutcomes({...baseInput, outcome: "survives"});
    // Full week of fees: $100k * 0.0020 = $200
    expect(out.creatorFeesUsd).toBeCloseTo(200, 5);
    // Net = slot ($35) - $200 = -$165
    expect(out.netUsd).toBeCloseTo(-165, 5);
    expect(out.bountyRangeUsd).toBeNull();
    expect(out.polBackingEth).toBeNull();
  });

  it("wins: full fees + bounty range + POL backing", () => {
    const out = calculateOutcomes({...baseInput, outcome: "wins"});
    expect(out.creatorFeesUsd).toBeCloseTo(200, 5);
    // Bounty range: peakMc=$50k → losers pot ∈ [$2,500, $10,000]; bounty (2.5%) ∈ [$62.50, $250]
    expect(out.bountyRangeUsd).not.toBeNull();
    expect(out.bountyRangeUsd!.low).toBeCloseTo(62.5, 5);
    expect(out.bountyRangeUsd!.high).toBeCloseTo(250, 5);
    // POL backing: midpoint of pot ($6,250) * 10% / $3500 ≈ 0.1786 ETH
    expect(out.polBackingEth).not.toBeNull();
    expect(out.polBackingEth!).toBeCloseTo(625 / 3500, 4);
  });

  /// Epic 1.16 (spec §10.3 + §10.6): perpetual long-tail. For wins, the projection sums
  /// 12 decaying weeks at 50% w/w past settlement (the launch week is captured
  /// separately by `creatorFeesUsd`). Geometric series:
  ///   $100k × 0.0020 × Σ(0.5^w for w in 1..12) = $200 × (1 - 0.5^12) ≈ $199.95
  it("wins: postSettlementLongTailUsd projects 12 weeks of decaying volume", () => {
    const out = calculateOutcomes({...baseInput, outcome: "wins"});
    expect(out.postSettlementLongTailUsd).not.toBeNull();
    // Sum of 0.5^1 + 0.5^2 + ... + 0.5^12 = 1 - 0.5^12 ≈ 0.99976
    const expected = 100_000 * 0.002 * (1 - Math.pow(0.5, 12));
    expect(out.postSettlementLongTailUsd!).toBeCloseTo(expected, 2);
    // The win-case netUsd MUST fold in the long-tail — pre-Epic-1.16 it didn't, and the
    // calculator under-stated winner ROI by ~1× the launch-week revenue.
    expect(out.netUsd).toBeLessThan(-out.creatorFeesUsd);
  });

  it("filtered + survives: postSettlementLongTailUsd is null (LP unwinds, no trades)", () => {
    expect(calculateOutcomes({...baseInput, outcome: "filtered"}).postSettlementLongTailUsd).toBeNull();
    expect(calculateOutcomes({...baseInput, outcome: "survives"}).postSettlementLongTailUsd).toBeNull();
  });

  it("breakeven volume = launch cost / 0.20%", () => {
    // $35 / 0.0020 = $17,500
    const out = calculateOutcomes({...baseInput, outcome: "filtered"});
    expect(out.breakevenVolumeUsd).toBeCloseTo(17_500, 5);
  });

  it("zero slot cost is tolerated (loading state)", () => {
    const out = calculateOutcomes({...baseInput, outcome: "filtered", slotCostWei: 0n, stakeWei: 0n});
    // No cost, only fee revenue: net = -$100
    expect(out.netUsd).toBeCloseTo(-100, 5);
    expect(out.breakevenVolumeUsd).toBe(0);
  });
});

describe("PRESETS — spec §45.4", () => {
  it("includes the three documented scenarios in order", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(["realistic", "solid", "viral"]);
  });
  it("realistic preset is intentionally a loss case", () => {
    const realistic = PRESETS[0]!;
    expect(realistic.outcome).toBe("filtered");
    expect(realistic.peakMcUsd).toBe(50_000);
    expect(realistic.weeklyVolumeUsd).toBe(100_000);
  });
  it("viral preset wins the week", () => {
    const viral = PRESETS[2]!;
    expect(viral.outcome).toBe("wins");
    expect(viral.peakMcUsd).toBe(5_000_000);
    expect(viral.weeklyVolumeUsd).toBe(10_000_000);
  });
});
