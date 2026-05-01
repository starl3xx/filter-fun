/// Cut-line math — exercises the rank → SAFE / AT_RISK / DANGER mapping.
/// `computeStats` is exported as the pure unit under test so we don't need
/// to render React or stub `/tokens` to assert the mapping.

import {describe, expect, it} from "vitest";

import {computeStats} from "@/hooks/token/useTokenStats";
import type {TokenResponse} from "@/lib/arena/api";

function makeToken(rank: number, status: TokenResponse["status"] = "SAFE"): TokenResponse {
  return {
    token: "0x0000000000000000000000000000000000000001",
    ticker: "$X",
    rank,
    hp: 50,
    status,
    price: "0",
    priceChange24h: 0,
    volume24h: "0",
    liquidity: "0",
    holders: 0,
    components: {velocity: 0.5, effectiveBuyers: 0.5, stickyLiquidity: 0.5, retention: 0.5, momentum: 0.5},
  };
}

describe("computeStats", () => {
  it("rank 1 → SAFE by 5", () => {
    const r = computeStats(makeToken(1));
    expect(r.cutLineStatus).toBe("SAFE");
    expect(r.cutLineLabel).toBe("SAFE by 5");
  });

  it("rank 4 → SAFE by 2", () => {
    const r = computeStats(makeToken(4));
    expect(r.cutLineStatus).toBe("SAFE");
    expect(r.cutLineLabel).toBe("SAFE by 2");
  });

  it("rank 5 → AT_RISK by 1 (next slip filters)", () => {
    const r = computeStats(makeToken(5));
    expect(r.cutLineStatus).toBe("AT_RISK");
    expect(r.cutLineLabel).toBe("AT RISK by 1");
  });

  it("rank 6 → AT_RISK by 0 (the cut line itself)", () => {
    const r = computeStats(makeToken(6));
    expect(r.cutLineStatus).toBe("AT_RISK");
    expect(r.cutLineLabel).toBe("AT RISK by 0");
  });

  it("rank 7 → DANGER (below cut)", () => {
    const r = computeStats(makeToken(7));
    expect(r.cutLineStatus).toBe("DANGER");
    expect(r.cutLineLabel).toBe("BELOW CUT by 1");
  });

  it("rank 12 → DANGER by 6 (last place)", () => {
    const r = computeStats(makeToken(12));
    expect(r.cutLineStatus).toBe("DANGER");
    expect(r.cutLineLabel).toBe("BELOW CUT by 6");
  });

  it("FILTERED status → FILTERED regardless of rank", () => {
    const r = computeStats(makeToken(1, "FILTERED"));
    expect(r.cutLineStatus).toBe("FILTERED");
  });

  it("FINALIST status → FINALIST regardless of rank", () => {
    const r = computeStats(makeToken(7, "FINALIST"));
    expect(r.cutLineStatus).toBe("FINALIST");
  });

  it("rank 0 (unscored) → SAFE with 'Unscored' copy", () => {
    const r = computeStats(makeToken(0));
    expect(r.cutLineStatus).toBe("SAFE");
    expect(r.cutLineLabel).toBe("Unscored");
  });
});
