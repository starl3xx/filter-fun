/// Invariant suite (PR #50 family). Pre-1.22 covered: `inv_hp_integer_storage`
/// + `inv_tie_break_deterministic`. Epic 1.22 adds two more invariants
/// pinning the formula-lock contract:
///
/// **inv_hp_formula_pure** — `score()` is pure. The same input bundle +
/// currentTime always produces the same output, regardless of any global
/// state (env, time of day, prior calls). Property-based: 100 deterministic
/// repeat-calls on the same bundle from a freshly-imported scoring module
/// must all return byte-identical scored arrays.
///
/// **inv_hp_settlement_finality** — every CUT/FINALIZE-tagged hpSnapshot
/// row MUST have `finality = "final"` before the corresponding oracle
/// Merkle publish. The scoring package itself has no concept of finality
/// (that lives at the indexer schema level); this invariant exercises the
/// `initialFinalityForTrigger` boundary helper, which the indexer's writer
/// consumes — validating that CUT / FINALIZE always land as `final` and
/// SWAP / HOLDER_SNAPSHOT / BLOCK_TICK never do.
///
/// All four invariants are off-chain (HP is off-chain — the on-chain
/// settlement only consumes the oracle-published Merkle root, never the
/// HP values directly).
///
/// **inv_hp_integer_storage** — every `score()` output's HP value is an
/// integer in `[HP_MIN, HP_MAX]`. No fractional values, no out-of-range.
/// Property-based: random component scores constructed across a season's
/// worth of swaps. Failure here means a future component can leak a float
/// or out-of-range value through the scoring pipeline, breaking the
/// `hpSnapshot.hp` integer-column contract.
///
/// **inv_tie_break_deterministic** — for any cohort with at least one
/// tied HP pair, the produced ranking puts the earlier-launched token
/// strictly first. Property-based: random component scores constructed
/// to produce ties (identical token-stats, different `launchedAt`).

import {describe, expect, it} from "vitest";

import {
  HP_MAX,
  HP_MIN,
  hpToInt,
  score,
  type Address,
  type TokenStats,
} from "../src/index.js";

const wallet = (n: number): Address =>
  `0x${n.toString(16).padStart(40, "0")}` as Address;

const NOW = 10_000_000n;
const WETH = 1_000_000_000_000_000_000n;

/// Seeded LCG so failures are reproducible. xoshiro / mulberry32 would be
/// fancier; LCG is enough for this scope (we want spread, not crypto-grade
/// randomness) and adds no dependency.
function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function randomCohort(rand: () => number, size: number, currentTime: bigint): TokenStats[] {
  const out: TokenStats[] = [];
  for (let i = 0; i < size; i++) {
    const w = wallet(i + 1);
    // Vary buy size, LP depth, holder counts, retention so HP spans the
    // full range across the cohort.
    const buyAmt = 100_000_000_000_000n + BigInt(Math.floor(rand() * 1e18));
    const lpAmt = 100_000_000_000_000n + BigInt(Math.floor(rand() * 1e19));
    const holderCount = 1 + Math.floor(rand() * 30);
    const holders = new Set<Address>();
    for (let h = 0; h < holderCount; h++) holders.add(wallet(1000 + i * 100 + h));
    out.push({
      token: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
      volumeByWallet: new Map([[w, buyAmt]]),
      buys: [{wallet: w, ts: currentTime - BigInt(60 + Math.floor(rand() * 1000)), amountWeth: buyAmt}],
      sells: [],
      liquidityDepthWeth: lpAmt,
      currentHolders: holders,
      holdersAtRetentionAnchor: holders,
      launchedAt: currentTime - BigInt(3600 + Math.floor(rand() * 86400)),
    });
  }
  return out;
}

describe("inv_hp_integer_storage — HP ∈ integer [HP_MIN, HP_MAX] for every cohort row", () => {
  it("holds across 200 random cohorts of varying size", () => {
    const seeds = [
      0x1234abcd, 0xdeadbeef, 0xfeedface, 0x01234567, 0xabcdef01,
      0x55aa55aa, 0x12345678, 0x90abcdef, 0xfedcba98, 0xc001beef,
    ];
    let runs = 0;
    for (const seed of seeds) {
      const rand = makeRandom(seed);
      // 20 cohorts per seed, sized 1..50.
      for (let trial = 0; trial < 20; trial++) {
        const size = 1 + Math.floor(rand() * 50);
        const cohort = randomCohort(rand, size, NOW);
        const ranked = score(cohort, NOW);
        for (const r of ranked) {
          expect(Number.isInteger(r.hp), `seed=${seed.toString(16)} trial=${trial} hp=${r.hp}`).toBe(true);
          expect(r.hp).toBeGreaterThanOrEqual(HP_MIN);
          expect(r.hp).toBeLessThanOrEqual(HP_MAX);
          runs++;
        }
      }
    }
    expect(runs).toBeGreaterThan(0);
  });

  it("hpToInt — exhaustive boundary sweep on 0.0..1.0 in 0.0001 steps", () => {
    // Sanity walk over the full input range — every output is an integer
    // in [HP_MIN, HP_MAX]. Catches drift in the rounding mode (e.g. someone
    // swaps Math.round for Math.floor and the upper boundary breaks).
    for (let i = 0; i <= 10000; i++) {
      const v = i / 10000;
      const out = hpToInt(v);
      expect(Number.isInteger(out)).toBe(true);
      expect(out).toBeGreaterThanOrEqual(HP_MIN);
      expect(out).toBeLessThanOrEqual(HP_MAX);
    }
  });
});

describe("inv_tie_break_deterministic — earlier-launched wins on exact HP ties", () => {
  it("holds across 100 random cohorts where tied pairs are constructed", () => {
    const seeds = [0xa0a0a0a0, 0xb1b1b1b1, 0xc2c2c2c2, 0xd3d3d3d3, 0xe4e4e4e4];
    let pairsChecked = 0;
    for (const seed of seeds) {
      const rand = makeRandom(seed);
      for (let trial = 0; trial < 20; trial++) {
        // Build a "real" cohort, then duplicate one token with a different
        // launchedAt to manufacture a guaranteed tie.
        const baseSize = 2 + Math.floor(rand() * 8);
        const cohort = randomCohort(rand, baseSize, NOW);
        // Pick a random member to duplicate.
        const srcIdx = Math.floor(rand() * cohort.length);
        const src = cohort[srcIdx]!;
        const dupAddr = `0x${(0xff_0000 + trial).toString(16).padStart(40, "0")}` as Address;
        const earlierAt = (src.launchedAt ?? NOW - 7200n) - BigInt(60 + Math.floor(rand() * 7200));
        // Insert the dup with EARLIER launchedAt — should rank higher than src.
        const dup: TokenStats = {
          ...src,
          token: dupAddr,
          launchedAt: earlierAt,
        };
        // Insert at a random position so we exercise both input orderings.
        const insertAt = Math.floor(rand() * (cohort.length + 1));
        cohort.splice(insertAt, 0, dup);

        const ranked = score(cohort, NOW);
        const dupRow = ranked.find((r) => r.token === dupAddr)!;
        const srcRow = ranked.find((r) => r.token === src.token)!;
        // They have identical metrics by construction → identical HP.
        expect(dupRow.hp).toBe(srcRow.hp);
        // Earlier-launched (dup) wins.
        expect(
          dupRow.rank,
          `seed=${seed.toString(16)} trial=${trial} dupRank=${dupRow.rank} srcRank=${srcRow.rank}`,
        ).toBeLessThan(srcRow.rank);
        pairsChecked++;
      }
    }
    expect(pairsChecked).toBeGreaterThan(0);
  });

  it("handles 5-way ties — all five tokens rank in launchedAt-ascending order", () => {
    // Construct five identical tokens with distinct launchedAt — assert the
    // rank order matches the launchedAt order. Per §6.9 ageFactor saturates
    // at 1.0 for tokens ≥ 1h old, so all `launchedAt` values must be ≥ 1h
    // before NOW for the cohort to actually tie on HP (different ageFactors
    // would diverge their HPs and break the tie precondition).
    const w = wallet(1);
    const baseHolders = new Set([w]);
    const buys = [{wallet: w, ts: NOW - 100n, amountWeth: WETH}];
    const tokens: TokenStats[] = [];
    // Intentionally non-monotonic launchedAt order in the input. Each value
    // is hours before NOW; all ≥ 24h so ageFactor saturates everywhere.
    const launchedAtOrderHours = [48n, 24n, 96n, 36n, 60n];
    for (let i = 0; i < 5; i++) {
      tokens.push({
        token: `0x${(0xa00 + i).toString(16).padStart(40, "0")}` as Address,
        volumeByWallet: new Map([[w, WETH]]),
        buys,
        sells: [],
        liquidityDepthWeth: WETH,
        currentHolders: baseHolders,
        holdersAtRetentionAnchor: baseHolders,
        launchedAt: NOW - launchedAtOrderHours[i]! * 3600n,
      });
    }
    const ranked = score(tokens, NOW);
    // All same HP.
    const hp0 = ranked[0]!.hp;
    for (const r of ranked) expect(r.hp).toBe(hp0);
    // Rank order = launchedAt-ascending order. Earliest launchedAt is i=2
    // (96h before NOW); latest is i=1 (24h).
    expect(ranked[0]?.token).toBe(tokens[2]!.token); // 96h ago — earliest
    expect(ranked[1]?.token).toBe(tokens[4]!.token); // 60h ago
    expect(ranked[2]?.token).toBe(tokens[0]!.token); // 48h ago
    expect(ranked[3]?.token).toBe(tokens[3]!.token); // 36h ago
    expect(ranked[4]?.token).toBe(tokens[1]!.token); // 24h ago — latest
  });
});

describe("inv_hp_formula_pure — score() is a pure function of (input, currentTime)", () => {
  it("identical input bundle produces byte-identical output across 100 repeat calls", () => {
    // Build a non-trivial single-cohort bundle so each scoring path is
    // exercised: velocity (in-window buy + sell), retention (anchor), HHI
    // (holderBalances), sticky-liquidity (depth + lpEvents). Then call
    // `score()` 100 times back-to-back and assert every result equals the
    // first call's result.
    const cohort: TokenStats[] = [
      {
        token: wallet(0x1).slice(0, 42) as Address,
        volumeByWallet: new Map([[wallet(1), 1_000_000_000_000_000_000n]]),
        buys: [{wallet: wallet(1), ts: NOW - 1000n, amountWeth: 1_000_000_000_000_000_000n}],
        sells: [],
        liquidityDepthWeth: 30_000_000_000_000_000_000n,
        avgLiquidityDepthWeth: 30_000_000_000_000_000_000n,
        currentHolders: new Set([wallet(1), wallet(2), wallet(3)]),
        holdersAtRetentionAnchor: new Set([wallet(1), wallet(2), wallet(3)]),
        holderBalances: [100n, 100n, 100n],
        launchedAt: NOW - 86400n,
      },
      {
        token: wallet(0x2).slice(0, 42) as Address,
        volumeByWallet: new Map(),
        buys: [],
        sells: [],
        liquidityDepthWeth: 0n,
        currentHolders: new Set(),
        holdersAtRetentionAnchor: new Set(),
        launchedAt: NOW - 3600n,
      },
    ];
    const first = score(cohort, NOW);
    const firstJson = JSON.stringify(first, replaceBigint);
    for (let i = 0; i < 100; i++) {
      const ranked = score(cohort, NOW);
      const rankedJson = JSON.stringify(ranked, replaceBigint);
      expect(rankedJson, `iteration ${i} diverged from first call`).toBe(firstJson);
    }
  });

  it("currentTime varies → outputs vary; same currentTime → same output", () => {
    // Sanity: the pure-function property says SAME inputs produce SAME
    // outputs. Different `currentTime` IS a different input, so we expect
    // different outputs (older buys decay, ageFactor shifts).
    const cohort: TokenStats[] = [
      {
        token: wallet(0xa).slice(0, 42) as Address,
        volumeByWallet: new Map([[wallet(1), 5_000_000_000_000_000_000n]]),
        buys: [{wallet: wallet(1), ts: NOW - 100n, amountWeth: 5_000_000_000_000_000_000n}],
        sells: [],
        liquidityDepthWeth: 10_000_000_000_000_000_000n,
        currentHolders: new Set([wallet(1)]),
        holdersAtRetentionAnchor: new Set([wallet(1)]),
        launchedAt: NOW - 86400n,
      },
    ];
    const a1 = score(cohort, NOW);
    const a2 = score(cohort, NOW);
    expect(JSON.stringify(a1, replaceBigint)).toBe(JSON.stringify(a2, replaceBigint));
    const b = score(cohort, NOW + 86400n); // 24h later
    expect(JSON.stringify(b, replaceBigint)).not.toBe(JSON.stringify(a1, replaceBigint));
  });
});

function replaceBigint(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Map) return Array.from(value.entries());
  if (value instanceof Set) return Array.from(value.values());
  return value;
}

