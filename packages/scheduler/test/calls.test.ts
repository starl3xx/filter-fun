import {describe, expect, it} from "vitest";
import type {Address} from "viem";

import {buildSettlementPayload} from "@filter-fun/oracle";

import {claimRolloverCall, finalizeCall, liquidateCall, submitSettlementCall} from "../src/calls.js";

const VAULT: Address = "0x000000000000000000000000000000000000fafe";
const W: Address = "0x9999999999999999999999999999999999999999";
const L1: Address = "0x1111111111111111111111111111111111111111";
const L2: Address = "0x2222222222222222222222222222222222222222";
const ALICE: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function samplePayload() {
  return buildSettlementPayload({
    ranking: [W, L1, L2],
    recoverable: new Map([[L1, 1_000_000_000_000_000_000n], [L2, 2_000_000_000_000_000_000n]]),
    slippageBps: 250,
    shares: new Map([[ALICE, 100n]]),
    liquidationDeadline: 1_700_000_000n,
  });
}

describe("submitSettlementCall", () => {
  it("forwards the payload fields in the order the contract expects", () => {
    const p = samplePayload();
    const c = submitSettlementCall(VAULT, p);
    expect(c.address).toBe(VAULT);
    expect(c.functionName).toBe("submitSettlement");
    expect(c.args).toEqual([
      p.winner,
      p.losers,
      p.minOuts,
      p.rolloverRoot,
      p.totalRolloverShares,
      p.liquidationDeadline,
    ]);
  });
});

describe("liquidateCall", () => {
  it("defaults minOutOverride to 0n", () => {
    const c = liquidateCall(VAULT, L1);
    expect(c.functionName).toBe("liquidate");
    expect(c.args).toEqual([L1, 0n]);
  });

  it("forwards an explicit minOutOverride", () => {
    const c = liquidateCall(VAULT, L1, 999n);
    expect(c.args).toEqual([L1, 999n]);
  });
});

describe("finalizeCall", () => {
  it("defaults both slippage guards to 0n", () => {
    const c = finalizeCall(VAULT);
    expect(c.functionName).toBe("finalize");
    expect(c.args).toEqual([0n, 0n]);
  });

  it("forwards rollover + POL slippage guards", () => {
    const c = finalizeCall(VAULT, 11n, 22n);
    expect(c.args).toEqual([11n, 22n]);
  });
});

describe("claimRolloverCall", () => {
  it("forwards share and proof", () => {
    const proof = ["0xdead" as const, "0xbeef" as const];
    const c = claimRolloverCall(VAULT, 50n, proof);
    expect(c.functionName).toBe("claimRollover");
    expect(c.args).toEqual([50n, proof]);
  });
});
