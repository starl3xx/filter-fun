import {describe, expect, it} from "vitest";
import type {Address} from "viem";

import {buildSettlementPayload} from "../src/settlement.js";
import {rolloverLeaf, verifyProof} from "../src/merkle.js";

const W: Address = "0x9999999999999999999999999999999999999999"; // winner
const L1: Address = "0x1111111111111111111111111111111111111111";
const L2: Address = "0x2222222222222222222222222222222222222222";
const ALICE: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL: Address = "0xcccccccccccccccccccccccccccccccccccccccc";

describe("buildSettlementPayload", () => {
  it("picks ranking[0] as winner and the rest as losers in order", () => {
    const p = buildSettlementPayload({
      ranking: [W, L1, L2],
      recoverable: new Map([[L1, 1_000_000_000n], [L2, 2_000_000_000n]]),
      slippageBps: 0,
      shares: new Map([[ALICE, 60n], [BOB, 40n]]),
      liquidationDeadline: 1_700_000_000n,
    });
    expect(p.winner).toBe(W);
    expect(p.losers).toEqual([L1, L2]);
    expect(p.liquidationDeadline).toBe(1_700_000_000n);
  });

  it("computes minOuts as recoverable * (10_000 - slippageBps) / 10_000", () => {
    const p = buildSettlementPayload({
      ranking: [W, L1, L2],
      recoverable: new Map([[L1, 10_000n], [L2, 1_000n]]),
      slippageBps: 250, // 2.5% slippage
      shares: new Map([[ALICE, 1n]]),
      liquidationDeadline: 1n,
    });
    expect(p.minOuts).toEqual([9_750n, 975n]);
  });

  it("excludes zero-share entries from the rollover tree", () => {
    const p = buildSettlementPayload({
      ranking: [W, L1],
      recoverable: new Map([[L1, 100n]]),
      slippageBps: 0,
      shares: new Map([[ALICE, 100n], [BOB, 0n], [CAROL, 50n]]),
      liquidationDeadline: 1n,
    });
    expect(p.tree.entries.map((e) => e.user)).toEqual([ALICE, BOB, CAROL].filter((a) => a !== BOB));
    expect(p.totalRolloverShares).toBe(150n);
  });

  it("emits proofs that verify against the published root", () => {
    const p = buildSettlementPayload({
      ranking: [W, L1],
      recoverable: new Map([[L1, 100n]]),
      slippageBps: 0,
      shares: new Map([[ALICE, 60n], [BOB, 40n], [CAROL, 25n]]),
      liquidationDeadline: 1n,
    });
    for (const e of p.tree.entries) {
      const leaf = rolloverLeaf(e.user, e.share);
      expect(verifyProof(leaf, e.proof, p.rolloverRoot)).toBe(true);
    }
  });

  it("totalRolloverShares matches the sum of leaf shares", () => {
    const shares = new Map<Address, bigint>([[ALICE, 7n], [BOB, 13n], [CAROL, 80n]]);
    const p = buildSettlementPayload({
      ranking: [W, L1],
      recoverable: new Map([[L1, 1n]]),
      slippageBps: 0,
      shares,
      liquidationDeadline: 1n,
    });
    expect(p.totalRolloverShares).toBe(100n);
  });

  it("is deterministic regardless of input map ordering", () => {
    const a = buildSettlementPayload({
      ranking: [W, L1],
      recoverable: new Map([[L1, 1n]]),
      slippageBps: 0,
      shares: new Map([[ALICE, 60n], [BOB, 40n]]),
      liquidationDeadline: 1n,
    });
    const b = buildSettlementPayload({
      ranking: [W, L1],
      recoverable: new Map([[L1, 1n]]),
      slippageBps: 0,
      shares: new Map([[BOB, 40n], [ALICE, 60n]]),
      liquidationDeadline: 1n,
    });
    expect(a.rolloverRoot).toBe(b.rolloverRoot);
  });

  it("rejects a ranking with no losers", () => {
    expect(() =>
      buildSettlementPayload({
        ranking: [W],
        recoverable: new Map(),
        slippageBps: 0,
        shares: new Map([[ALICE, 1n]]),
        liquidationDeadline: 1n,
      }),
    ).toThrow(/winner and ≥1 loser/);
  });

  it("rejects missing recoverable quote", () => {
    expect(() =>
      buildSettlementPayload({
        ranking: [W, L1],
        recoverable: new Map(),
        slippageBps: 0,
        shares: new Map([[ALICE, 1n]]),
        liquidationDeadline: 1n,
      }),
    ).toThrow(/recoverable quote/);
  });

  it("rejects empty positive-share set", () => {
    expect(() =>
      buildSettlementPayload({
        ranking: [W, L1],
        recoverable: new Map([[L1, 1n]]),
        slippageBps: 0,
        shares: new Map([[ALICE, 0n]]),
        liquidationDeadline: 1n,
      }),
    ).toThrow(/no positive shares/);
  });

  it("rejects out-of-range slippageBps", () => {
    expect(() =>
      buildSettlementPayload({
        ranking: [W, L1],
        recoverable: new Map([[L1, 1n]]),
        slippageBps: 10_000,
        shares: new Map([[ALICE, 1n]]),
        liquidationDeadline: 1n,
      }),
    ).toThrow(/slippageBps/);
  });
});
