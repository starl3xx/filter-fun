import {describe, expect, it} from "vitest";
import type {Address} from "viem";

import {buildFilterEventPayload, buildSettlementPayload} from "@filter-fun/oracle";

import {claimRolloverCall, processFilterEventCall, submitWinnerCall} from "../src/calls.js";

const VAULT: Address = "0x000000000000000000000000000000000000fafe";
const W: Address = "0x9999999999999999999999999999999999999999";
const L1: Address = "0x1111111111111111111111111111111111111111";
const L2: Address = "0x2222222222222222222222222222222222222222";
const ALICE: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("processFilterEventCall", () => {
  it("forwards losers + minOuts in the order the contract expects", () => {
    const p = buildFilterEventPayload({
      losers: [L1, L2],
      recoverable: new Map([[L1, 1_000_000_000_000_000_000n], [L2, 2_000_000_000_000_000_000n]]),
      slippageBps: 250,
    });
    const c = processFilterEventCall(VAULT, p);
    expect(c.address).toBe(VAULT);
    expect(c.functionName).toBe("processFilterEvent");
    expect(c.args).toEqual([p.losers, p.minOuts]);
  });
});

describe("submitWinnerCall", () => {
  it("forwards winner, root, totalShares, and slippage guards", () => {
    const p = buildSettlementPayload({
      winner: W,
      shares: new Map([[ALICE, 100n]]),
      minWinnerTokensRollover: 11n,
      minWinnerTokensPol: 22n,
    });
    const c = submitWinnerCall(VAULT, p);
    expect(c.functionName).toBe("submitWinner");
    expect(c.args).toEqual([
      p.winner,
      p.rolloverRoot,
      p.totalRolloverShares,
      p.minWinnerTokensRollover,
      p.minWinnerTokensPol,
    ]);
  });

  it("defaults slippage guards to 0n when payload omits them", () => {
    const p = buildSettlementPayload({winner: W, shares: new Map([[ALICE, 1n]])});
    const c = submitWinnerCall(VAULT, p);
    expect(c.args[3]).toBe(0n);
    expect(c.args[4]).toBe(0n);
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
