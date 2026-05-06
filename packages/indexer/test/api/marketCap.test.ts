/// Epic 1.28 — `/tokens` `marketCap` + `totalSupply` derivation.
///
/// Pins the wire contract (totalSupply is the FIXED_TOKEN_SUPPLY_WHOLE
/// constant, marketCap is `price × totalSupply` as decimal-ether) so a
/// future contract change that varies supply per-token can't silently
/// regress the cohort-wide constant assumption.

import {describe, expect, it} from "vitest";

import {
  buildTokensResponse,
  deriveMarketCap,
  FIXED_TOKEN_SUPPLY_WHOLE,
  TOKEN_DATA_AVAILABILITY,
  type TokenRow,
} from "../../src/api/builders.js";

function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

const baseRow: TokenRow = {
  id: addr(1),
  symbol: "FILTER",
  isFinalist: false,
  liquidated: false,
  liquidationProceeds: null,
  creator: "0x000000000000000000000000000000000000beef",
  createdAt: 0n,
};

describe("deriveMarketCap (Epic 1.28)", () => {
  it("returns null when price is null (V4 reads pending)", () => {
    expect(deriveMarketCap(null, FIXED_TOKEN_SUPPLY_WHOLE)).toBeNull();
  });

  it("returns null when price is malformed (defensive)", () => {
    expect(deriveMarketCap("not-a-number", FIXED_TOKEN_SUPPLY_WHOLE)).toBeNull();
    expect(deriveMarketCap("", FIXED_TOKEN_SUPPLY_WHOLE)).toBeNull();
  });

  it("computes integer market cap for whole-number prices", () => {
    // price = 0.0001 ETH per token, supply = 1e9 → cap = 100,000 ETH.
    expect(deriveMarketCap("0.0001", FIXED_TOKEN_SUPPLY_WHOLE)).toBe("100000");
  });

  it("preserves precision for fractional prices", () => {
    // price = 0.000000001 ETH per token, supply = 1e9 → cap = 1 ETH exactly.
    expect(deriveMarketCap("0.000000001", FIXED_TOKEN_SUPPLY_WHOLE)).toBe("1");
  });

  it("rounds in lockstep with weiToDecimalEther's 6-decimal rule", () => {
    // price = 0.0000123 → cap = 0.0000123 × 1e9 = 12,300 ETH (integer).
    expect(deriveMarketCap("0.0000123", FIXED_TOKEN_SUPPLY_WHOLE)).toBe("12300");
  });

  it("handles a zero price (placeholder before v4Reads flips)", () => {
    expect(deriveMarketCap("0", FIXED_TOKEN_SUPPLY_WHOLE)).toBe("0");
  });
});

describe("buildTokensResponse marketCap + totalSupply (Epic 1.28)", () => {
  it("emits totalSupply as the FIXED_TOKEN_SUPPLY_WHOLE constant on every row", () => {
    const out = buildTokensResponse([baseRow], new Map(), "competition", new Map(), 0n);
    expect(out[0]!.totalSupply).toBe(FIXED_TOKEN_SUPPLY_WHOLE.toString());
    expect(out[0]!.totalSupply).toBe("1000000000");
  });

  it("emits marketCap=null while v4Reads is false (mirrors the price=null gate)", () => {
    expect(TOKEN_DATA_AVAILABILITY.v4Reads).toBe(false);
    const out = buildTokensResponse([baseRow], new Map(), "competition", new Map(), 0n);
    expect(out[0]!.price).toBeNull();
    expect(out[0]!.marketCap).toBeNull();
  });
});
