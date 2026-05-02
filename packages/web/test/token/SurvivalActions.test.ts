/// SurvivalActions — pure tip computation against the 0.45 threshold. Each
/// component check is independent; multiple low components produce multiple
/// tips. The "all systems steady" branch fires when every component is at or
/// above the threshold.

import {describe, expect, it} from "vitest";

import {computeTips} from "@/components/admin/SurvivalActions";
import type {TokenResponse} from "@/lib/arena/api";

function token(components: Partial<TokenResponse["components"]>): TokenResponse {
  return {
    token: "0x0000000000000000000000000000000000000001",
    ticker: "$X",
    rank: 1,
    hp: 50,
    status: "SAFE",
    price: "0",
    priceChange24h: 0,
    volume24h: "0",
    liquidity: "0",
    holders: 0,
    components: {
      velocity: 0.6,
      effectiveBuyers: 0.6,
      stickyLiquidity: 0.6,
      retention: 0.6,
      momentum: 0.6,
      ...components,
    },
    bagLock: {isLocked: false, unlockTimestamp: null, creator: "0x0000000000000000000000000000000000000000"},
  };
}

describe("computeTips", () => {
  it("all healthy → no tips", () => {
    expect(computeTips(token({}))).toEqual([]);
  });

  it("low retention → 'Holder conviction is dropping'", () => {
    const tips = computeTips(token({retention: 0.3}));
    expect(tips).toHaveLength(1);
    expect(tips[0].label).toContain("Holder conviction");
  });

  it("low stickyLiquidity → 'Liquidity strength is thin'", () => {
    const tips = computeTips(token({stickyLiquidity: 0.2}));
    expect(tips[0].label).toContain("Liquidity strength");
  });

  it("low effectiveBuyers → 'Real participation is low'", () => {
    const tips = computeTips(token({effectiveBuyers: 0.1}));
    expect(tips[0].label).toContain("Real participation");
  });

  it("low velocity → 'Buying activity is slowing'", () => {
    const tips = computeTips(token({velocity: 0.1}));
    expect(tips[0].label).toContain("Buying activity");
  });

  it("low momentum → 'Momentum is fading'", () => {
    const tips = computeTips(token({momentum: 0.2}));
    expect(tips[0].label).toContain("Momentum");
  });

  it("two low components → two tips", () => {
    const tips = computeTips(token({retention: 0.2, velocity: 0.1}));
    expect(tips).toHaveLength(2);
  });

  it("threshold boundary 0.45 → no tip (at threshold is healthy)", () => {
    expect(computeTips(token({retention: 0.45}))).toEqual([]);
  });

  it("just below threshold (0.449) → tip fires", () => {
    expect(computeTips(token({retention: 0.449}))).toHaveLength(1);
  });
});
