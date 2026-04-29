import {describe, expect, it} from "vitest";
import type {Address} from "viem";

import {buildFilterEventPayload, buildSettlementPayload} from "../src/settlement.js";
import {rolloverLeaf, verifyProof} from "../src/merkle.js";

const W: Address = "0x9999999999999999999999999999999999999999"; // winner
const L1: Address = "0x1111111111111111111111111111111111111111";
const L2: Address = "0x2222222222222222222222222222222222222222";
const ALICE: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL: Address = "0xcccccccccccccccccccccccccccccccccccccccc";

describe("buildFilterEventPayload", () => {
  it("computes minOuts as recoverable * (10_000 - slippageBps) / 10_000", () => {
    const p = buildFilterEventPayload({
      losers: [L1, L2],
      recoverable: new Map([[L1, 10_000n], [L2, 1_000n]]),
      slippageBps: 250, // 2.5% slippage
    });
    expect(p.losers).toEqual([L1, L2]);
    expect(p.minOuts).toEqual([9_750n, 975n]);
  });

  it("rejects empty losers", () => {
    expect(() =>
      buildFilterEventPayload({losers: [], recoverable: new Map(), slippageBps: 0}),
    ).toThrow(/at least one loser/);
  });

  it("rejects missing recoverable quote", () => {
    expect(() =>
      buildFilterEventPayload({losers: [L1], recoverable: new Map(), slippageBps: 0}),
    ).toThrow(/recoverable quote/);
  });

  it("rejects out-of-range slippageBps", () => {
    expect(() =>
      buildFilterEventPayload({losers: [L1], recoverable: new Map([[L1, 1n]]), slippageBps: 10_000}),
    ).toThrow(/slippageBps/);
  });
});

describe("buildSettlementPayload", () => {
  it("encodes the winner + rollover root + total shares", () => {
    const p = buildSettlementPayload({
      winner: W,
      shares: new Map([[ALICE, 60n], [BOB, 40n]]),
    });
    expect(p.winner).toBe(W);
    expect(p.totalRolloverShares).toBe(100n);
    expect(p.tree.entries.map((e) => e.user)).toEqual([ALICE, BOB]);
  });

  it("threads the slippage guards through", () => {
    const p = buildSettlementPayload({
      winner: W,
      shares: new Map([[ALICE, 1n]]),
      minWinnerTokensRollover: 12_345n,
      minWinnerTokensPol: 67_890n,
    });
    expect(p.minWinnerTokensRollover).toBe(12_345n);
    expect(p.minWinnerTokensPol).toBe(67_890n);
  });

  it("defaults slippage guards to 0 when omitted", () => {
    const p = buildSettlementPayload({winner: W, shares: new Map([[ALICE, 1n]])});
    expect(p.minWinnerTokensRollover).toBe(0n);
    expect(p.minWinnerTokensPol).toBe(0n);
  });

  it("excludes zero-share entries from the rollover tree", () => {
    const p = buildSettlementPayload({
      winner: W,
      shares: new Map([[ALICE, 100n], [BOB, 0n], [CAROL, 50n]]),
    });
    expect(p.tree.entries.map((e) => e.user)).toEqual([ALICE, CAROL]);
    expect(p.totalRolloverShares).toBe(150n);
  });

  it("emits proofs that verify against the published root", () => {
    const p = buildSettlementPayload({
      winner: W,
      shares: new Map([[ALICE, 60n], [BOB, 40n], [CAROL, 25n]]),
    });
    for (const e of p.tree.entries) {
      const leaf = rolloverLeaf(e.user, e.share);
      expect(verifyProof(leaf, e.proof, p.rolloverRoot)).toBe(true);
    }
  });

  it("is deterministic regardless of input map ordering", () => {
    const a = buildSettlementPayload({
      winner: W,
      shares: new Map([[ALICE, 60n], [BOB, 40n]]),
    });
    const b = buildSettlementPayload({
      winner: W,
      shares: new Map([[BOB, 40n], [ALICE, 60n]]),
    });
    expect(a.rolloverRoot).toBe(b.rolloverRoot);
  });

  it("rejects empty positive-share set", () => {
    expect(() =>
      buildSettlementPayload({winner: W, shares: new Map([[ALICE, 0n]])}),
    ).toThrow(/no positive shares/);
  });
});
