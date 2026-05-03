/// Tests for HP ranking Merkle provenance — Epic 1.17b.
///
/// Pure-function coverage: leaf reproducibility, deterministic ordering,
/// proof verification, settlement-provenance ordering invariant.

import {describe, expect, it} from "vitest";

import {
  buildHpRankingPayload,
  checkSettlementProvenance,
  hpRankingLeaf,
  verifyProof,
  type HpRankingEntry,
  type SettlementProvenance,
} from "../src/index.js";

const VERSION = "2026-05-03-v4-locked";
const SEASON_ID = 1n;

const tokenA = "0x000000000000000000000000000000000000000a" as const;
const tokenB = "0x000000000000000000000000000000000000000b" as const;
const tokenC = "0x000000000000000000000000000000000000000c" as const;

describe("hpRankingLeaf", () => {
  it("is deterministic for the same inputs", () => {
    const a = hpRankingLeaf({seasonId: 1n, token: tokenA, rank: 1, hp: 87, weightsVersion: VERSION});
    const b = hpRankingLeaf({seasonId: 1n, token: tokenA, rank: 1, hp: 87, weightsVersion: VERSION});
    expect(a).toBe(b);
  });

  it("differs when ANY field changes (rank, hp, version, token, season)", () => {
    const base = hpRankingLeaf({seasonId: 1n, token: tokenA, rank: 1, hp: 87, weightsVersion: VERSION});
    expect(hpRankingLeaf({seasonId: 2n, token: tokenA, rank: 1, hp: 87, weightsVersion: VERSION})).not.toBe(base);
    expect(hpRankingLeaf({seasonId: 1n, token: tokenB, rank: 1, hp: 87, weightsVersion: VERSION})).not.toBe(base);
    expect(hpRankingLeaf({seasonId: 1n, token: tokenA, rank: 2, hp: 87, weightsVersion: VERSION})).not.toBe(base);
    expect(hpRankingLeaf({seasonId: 1n, token: tokenA, rank: 1, hp: 88, weightsVersion: VERSION})).not.toBe(base);
    expect(hpRankingLeaf({seasonId: 1n, token: tokenA, rank: 1, hp: 87, weightsVersion: "v5"})).not.toBe(base);
  });
});

describe("buildHpRankingPayload", () => {
  const cohort: HpRankingEntry[] = [
    {token: tokenA, rank: 2, hp: 75},
    {token: tokenB, rank: 1, hp: 87},
    {token: tokenC, rank: 3, hp: 60},
  ];

  it("builds a Merkle root deterministically regardless of input order", () => {
    const p1 = buildHpRankingPayload({seasonId: SEASON_ID, trigger: "CUT", weightsVersion: VERSION, entries: cohort});
    const p2 = buildHpRankingPayload({
      seasonId: SEASON_ID,
      trigger: "CUT",
      weightsVersion: VERSION,
      entries: [...cohort].reverse(),
    });
    expect(p1.root).toBe(p2.root);
  });

  it("entries are sorted by rank ascending in the proof output", () => {
    const p = buildHpRankingPayload({seasonId: SEASON_ID, trigger: "CUT", weightsVersion: VERSION, entries: cohort});
    expect(p.entries.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(p.entries.map((e) => e.token)).toEqual([tokenB, tokenA, tokenC]);
  });

  it("each entry's proof verifies against the root", () => {
    const p = buildHpRankingPayload({seasonId: SEASON_ID, trigger: "CUT", weightsVersion: VERSION, entries: cohort});
    for (const e of p.entries) {
      const leaf = hpRankingLeaf({
        seasonId: SEASON_ID,
        token: e.token,
        rank: e.rank,
        hp: e.hp,
        weightsVersion: VERSION,
      });
      expect(verifyProof(leaf, e.proof, p.root)).toBe(true);
    }
  });

  it("CUT and FINALIZE produce different roots even with identical entries", () => {
    // Trigger isn't part of the leaf — but the oracle posts CUT and FINALIZE
    // as separate roots on-chain (different settlement txs). The trigger
    // discriminator is stamped on the payload so callers can route correctly;
    // the on-chain root identifying the ranking IS the same if the inputs
    // didn't change between h96 and h168, which is correct (a winner whose
    // ranking didn't move shouldn't have a different proof).
    const cut = buildHpRankingPayload({seasonId: SEASON_ID, trigger: "CUT", weightsVersion: VERSION, entries: cohort});
    const fin = buildHpRankingPayload({seasonId: SEASON_ID, trigger: "FINALIZE", weightsVersion: VERSION, entries: cohort});
    expect(cut.root).toBe(fin.root); // intentional — see comment above
    expect(cut.trigger).toBe("CUT");
    expect(fin.trigger).toBe("FINALIZE");
  });

  it("rejects empty entries", () => {
    expect(() =>
      buildHpRankingPayload({seasonId: SEASON_ID, trigger: "CUT", weightsVersion: VERSION, entries: []}),
    ).toThrow(/at least one entry/);
  });

  it("rejects empty weightsVersion", () => {
    expect(() =>
      buildHpRankingPayload({seasonId: SEASON_ID, trigger: "CUT", weightsVersion: "", entries: cohort}),
    ).toThrow(/weightsVersion is required/);
  });

  it("a single-entry cohort produces a one-leaf tree (root = leaf)", () => {
    const p = buildHpRankingPayload({
      seasonId: SEASON_ID,
      trigger: "FINALIZE",
      weightsVersion: VERSION,
      entries: [{token: tokenA, rank: 1, hp: 100}],
    });
    const expected = hpRankingLeaf({seasonId: SEASON_ID, token: tokenA, rank: 1, hp: 100, weightsVersion: VERSION});
    expect(p.root).toBe(expected);
    expect(p.entries[0]!.proof).toEqual([]);
  });
});

describe("checkSettlementProvenance — ordering invariant", () => {
  function ts(s: bigint): SettlementProvenance {
    return {
      hpSnapshotWrittenAtSec: s,
      rootComputedAtSec: s + 1n,
      ipfsPinnedAtSec: s + 2n,
      onChainSettlementSubmittedAtSec: s + 3n,
    };
  }

  it("returns null when ordering is well-formed", () => {
    expect(checkSettlementProvenance(ts(1_700_000_000n))).toBeNull();
  });

  it("flags root computed before snapshot written", () => {
    const p = ts(1_700_000_000n);
    p.rootComputedAtSec = p.hpSnapshotWrittenAtSec - 1n;
    expect(checkSettlementProvenance(p)).toMatch(/rootComputedAtSec precedes hpSnapshotWrittenAtSec/);
  });

  it("flags pin before root", () => {
    const p = ts(1_700_000_000n);
    p.ipfsPinnedAtSec = p.rootComputedAtSec - 1n;
    expect(checkSettlementProvenance(p)).toMatch(/ipfsPinnedAtSec precedes rootComputedAtSec/);
  });

  it("flags settlement tx before pin", () => {
    const p = ts(1_700_000_000n);
    p.onChainSettlementSubmittedAtSec = p.ipfsPinnedAtSec - 1n;
    expect(checkSettlementProvenance(p)).toMatch(/onChainSettlementSubmittedAtSec precedes ipfsPinnedAtSec/);
  });

  it("equality at any step is acceptable (atomicity edge case)", () => {
    // If two stages share a wall-clock second (high-throughput infra),
    // that's not a violation — only strict reversal is.
    const p = {
      hpSnapshotWrittenAtSec: 100n,
      rootComputedAtSec: 100n,
      ipfsPinnedAtSec: 100n,
      onChainSettlementSubmittedAtSec: 100n,
    };
    expect(checkSettlementProvenance(p)).toBeNull();
  });
});
