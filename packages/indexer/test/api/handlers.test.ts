/// API handler tests — the /season + /tokens + /token/:address surfaces.
///
/// Vitest can't import "@/generated" (Ponder's runtime registry), so the routes themselves
/// aren't directly executable here. Instead we exercise the pure handlers in `handlers.ts`,
/// which take an `ApiQueries` interface — a fixture in tests, a Drizzle adapter in prod.

import {describe, expect, it} from "vitest";

import {weiToDecimalEther} from "../../src/api/builders.js";
import {
  getSeasonHandler,
  getTokenDetailHandler,
  getTokensHandler,
  isAddressLike,
  type ApiQueries,
  type TokenDetailRow,
} from "../../src/api/handlers.js";
import {scoreCohort} from "../../src/api/hp.js";
import {statusOf} from "../../src/api/status.js";
import type {SeasonRow, TokenRow} from "../../src/api/builders.js";

// ============================================================ Fixture builders

const HOUR = 3600n;
const DAY = 24n * HOUR;

/// Season started exactly 1 day ago at the time the tests run. Lets cadence assertions
/// (next-cut at 96h, settlement at 168h) compare against `startedAt + offset`.
const STARTED_AT = 1_700_000_000n;

function mkSeason(over: Partial<SeasonRow> = {}): SeasonRow {
  return {
    id: 1n,
    startedAt: STARTED_AT,
    phase: "Launch",
    totalPot: 0n,
    bonusReserve: 0n,
    ...over,
  };
}

function mkToken(over: Partial<TokenRow> & {id: `0x${string}`; symbol: string}): TokenRow {
  return {
    isFinalist: false,
    liquidated: false,
    liquidationProceeds: null,
    ...over,
  };
}

function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

function fixtureQueries(opts: {
  season: SeasonRow | null;
  tokens?: TokenRow[];
  publicLaunchCount?: number;
  detailLookup?: Record<string, TokenDetailRow>;
  bagLocks?: Array<{
    token: `0x${string}`;
    creator: `0x${string}`;
    unlockTimestamp: bigint;
  }>;
}): ApiQueries {
  return {
    latestSeason: async () => opts.season,
    publicLaunchCount: async () => opts.publicLaunchCount ?? 0,
    tokensInSeason: async () => opts.tokens ?? [],
    tokenByAddress: async (a) => opts.detailLookup?.[a] ?? null,
    bagLocksForTokens: async () => opts.bagLocks ?? [],
  };
}

// ============================================================ /season

describe("/season", () => {
  // Audit H-2 (2026-05-01): /season returns 200 with `{status, season}` envelope
  // instead of 404 when no season is indexed. Behaviour pinned in
  // test/api/security/endpointStatusContract.test.ts; the assertions here cover
  // the envelope shape end-to-end.
  it("returns 200 with status=not-ready when no season has been indexed yet", async () => {
    const r = await getSeasonHandler(fixtureQueries({season: null}));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({status: "not-ready", season: null});
  });

  it("empty season — launch phase, no launches yet", async () => {
    const r = await getSeasonHandler(
      fixtureQueries({season: mkSeason({phase: "Launch"}), publicLaunchCount: 0}),
    );
    expect(r.status).toBe(200);
    const env = r.body as unknown as {status: string; season: Record<string, unknown>};
    expect(env.status).toBe("ready");
    expect(env.season).toMatchObject({
      seasonId: 1,
      phase: "launch",
      launchCount: 0,
      maxLaunches: 12,
      championPool: "0",
      polReserve: "0",
    });
    // nextCutAt is start + 96h (Day 4 hard cut) while in launch/competition.
    const cutAt = env.season.nextCutAt as string;
    const settleAt = env.season.finalSettlementAt as string;
    expect(new Date(cutAt).getTime() / 1000).toBe(Number(STARTED_AT + 4n * DAY));
    expect(new Date(settleAt).getTime() / 1000).toBe(Number(STARTED_AT + 7n * DAY));
  });

  it("competition phase at 12/12 launches surfaces full launchCount + championPool", async () => {
    const r = await getSeasonHandler(
      fixtureQueries({
        season: mkSeason({
          phase: "Filter",
          totalPot: 30n * 10n ** 18n, // 30 ETH liquidated from cuts
          bonusReserve: 5n * 10n ** 18n, // 5 ETH set aside for hold bonus
        }),
        publicLaunchCount: 12,
      }),
    );
    expect(r.status).toBe(200);
    const env = r.body as unknown as {status: string; season: Record<string, unknown>};
    expect(env.status).toBe("ready");
    expect(env.season).toMatchObject({
      phase: "competition",
      launchCount: 12,
      championPool: "25", // 30 - 5
    });
  });

  it("finals phase shifts nextCutAt to the final-settlement anchor", async () => {
    const r = await getSeasonHandler(
      fixtureQueries({season: mkSeason({phase: "Finals"})}),
    );
    const env = r.body as unknown as {status: string; season: Record<string, unknown>};
    expect(env.status).toBe("ready");
    expect(env.season.phase).toBe("finals");
    expect(new Date(env.season.nextCutAt as string).getTime() / 1000)
      .toBe(Number(STARTED_AT + 7n * DAY));
  });

  it("settlement / closed phases collapse to 'settled'", async () => {
    for (const p of ["Settlement", "Closed"]) {
      const r = await getSeasonHandler(
        fixtureQueries({season: mkSeason({phase: p})}),
      );
      const env = r.body as unknown as {status: string; season: Record<string, unknown>};
      expect(env.season.phase).toBe("settled");
    }
  });
});

// ============================================================ /tokens

describe("/tokens", () => {
  it("returns [] before any season exists", async () => {
    const r = await getTokensHandler(fixtureQueries({season: null}), 0n);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("launch phase: every token is SAFE even when scoring assigns ranks 1..12", async () => {
    // Bugbot Medium #2 regression at the response level: with degenerate inputs `score()`
    // still hands back ranks (ties broken arbitrarily). Without the launch-phase short
    // circuit, tokens 7..12 would surface as AT_RISK / FILTERED before any competition
    // has begun — wrong product behavior.
    const tokens = Array.from({length: 12}, (_, i) =>
      mkToken({id: addr(i + 1), symbol: `T${i + 1}`}),
    );
    const r = await getTokensHandler(
      fixtureQueries({season: mkSeason({phase: "Launch"}), tokens}),
      STARTED_AT + 12n * HOUR,
    );
    const list = r.body as unknown as Array<Record<string, unknown>>;
    for (const tok of list) {
      expect(tok.status).toBe("SAFE");
    }
  });

  it("returns the cohort with shape per spec §26.4 — full 12-token competition season", async () => {
    const tokens = Array.from({length: 12}, (_, i) =>
      mkToken({
        id: addr(i + 1),
        symbol: i === 0 ? "FILTER" : `TKN${i}`,
      }),
    );
    const r = await getTokensHandler(
      fixtureQueries({season: mkSeason({phase: "Filter"}), tokens}),
      STARTED_AT + 12n * HOUR,
    );
    expect(r.status).toBe(200);
    const list = r.body as unknown as Array<Record<string, unknown>>;
    expect(list).toHaveLength(12);
    // Spec shape: every key present, ticker prefixed with `$`.
    for (const tok of list) {
      expect(tok.token).toMatch(/^0x[0-9a-f]{40}$/);
      expect(typeof (tok.ticker as string)).toBe("string");
      expect((tok.ticker as string).startsWith("$")).toBe(true);
      expect(typeof tok.hp).toBe("number");
      expect(typeof tok.rank).toBe("number");
      expect(["SAFE", "AT_RISK", "FINALIST", "FILTERED"]).toContain(tok.status);
      expect(tok.components).toMatchObject({
        velocity: expect.any(Number),
        effectiveBuyers: expect.any(Number),
        stickyLiquidity: expect.any(Number),
        retention: expect.any(Number),
        momentum: expect.any(Number),
      });
    }
    // Result is sorted by rank ascending.
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!.rank as number;
      const cur = list[i]!.rank as number;
      // Either strictly increasing or both zero (tie / unscored).
      expect(prev === 0 ? true : prev <= cur).toBe(true);
    }
    // First token should be the protocol-launched FILTER (alphabetical-by-id when uniform-cohort).
    expect((list[0]!.ticker as string)).toBe("$FILTER");
  });

  it("finals phase: status mapping caps the visible cohort at 6 SAFE/FINALIST slots", async () => {
    // 12 tokens, top-6 already promoted to finalists by `setFinalists`. The bottom 6 still
    // exist in the cohort (they may be already-liquidated zombies per spec §36.1.2) — the
    // status field is what tells the UI to render them dimmed.
    const tokens: TokenRow[] = Array.from({length: 12}, (_, i) =>
      mkToken({
        id: addr(i + 1),
        symbol: `T${i + 1}`,
        // Finalists set on the top 6 ids (1..6) — note the rank assignment will derive from
        // `score()`, but with degenerate inputs every token ties. That's fine for this test:
        // `isFinalist` short-circuits the rank-based status via the precedence chain.
        isFinalist: i < 6,
        // The bottom 6 have been liquidated as part of the filter step.
        liquidated: i >= 6,
        liquidationProceeds: i >= 6 ? 1n * 10n ** 17n : null,
      }),
    );
    const r = await getTokensHandler(
      fixtureQueries({season: mkSeason({phase: "Finals"}), tokens}),
      STARTED_AT + 4n * DAY,
    );
    const list = r.body as unknown as Array<Record<string, unknown>>;
    const finalists = list.filter((t) => t.status === "FINALIST");
    const filtered = list.filter((t) => t.status === "FILTERED");
    expect(finalists).toHaveLength(6);
    expect(filtered).toHaveLength(6);
  });
});

// ============================================================ /token/:address

describe("/token/:address", () => {
  it("404 for an address the indexer has never seen", async () => {
    const r = await getTokenDetailHandler(
      fixtureQueries({season: null, detailLookup: {}}),
      addr(99),
    );
    expect(r.status).toBe(404);
    expect(r.body).toEqual({error: "unknown token"});
  });

  it("400 for a malformed address", async () => {
    const r = await getTokenDetailHandler(
      fixtureQueries({season: null}),
      "not-an-address",
    );
    expect(r.status).toBe(400);
  });

  it("200 + details for an indexed token", async () => {
    const a = addr(1);
    const detail: TokenDetailRow = {
      id: a,
      symbol: "FILTER",
      isFinalist: true,
      liquidated: false,
      liquidationProceeds: null,
      name: "filter.fun",
      seasonId: 1n,
      isProtocolLaunched: true,
    };
    const r = await getTokenDetailHandler(
      fixtureQueries({season: null, detailLookup: {[a]: detail}}),
      a,
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      token: a,
      ticker: "$FILTER",
      name: "filter.fun",
      seasonId: 1,
      isProtocolLaunched: true,
      isFinalist: true,
      liquidated: false,
    });
  });

  it("address validator accepts checksumed/lowercase, rejects bad lengths", () => {
    expect(isAddressLike("0x" + "a".repeat(40))).toBe(true);
    expect(isAddressLike("0x" + "a".repeat(39))).toBe(false);
    expect(isAddressLike("0xZZ" + "a".repeat(38))).toBe(false);
    expect(isAddressLike("a".repeat(42))).toBe(false);
  });
});

// ============================================================ Status mapping

describe("status mapping", () => {
  it("rank ≤ 6 is SAFE outside finals", () => {
    expect(statusOf({phase: "competition", rank: 1, isFinalist: false, liquidated: false}))
      .toBe("SAFE");
    expect(statusOf({phase: "competition", rank: 6, isFinalist: false, liquidated: false}))
      .toBe("SAFE");
  });
  it("launch phase forces SAFE regardless of rank — pre-cut, no token is at risk", () => {
    // Bugbot Medium #2 regression: previously `phase` was ignored, so a token ranked 7
    // during launch would surface as AT_RISK even though no cut threat exists yet.
    for (const rank of [1, 6, 7, 9, 10, 12]) {
      expect(statusOf({phase: "launch", rank, isFinalist: false, liquidated: false}))
        .toBe("SAFE");
    }
  });
  it("rank 7-9 is AT_RISK", () => {
    expect(statusOf({phase: "competition", rank: 7, isFinalist: false, liquidated: false}))
      .toBe("AT_RISK");
    expect(statusOf({phase: "competition", rank: 9, isFinalist: false, liquidated: false}))
      .toBe("AT_RISK");
  });
  it("rank ≥ 10 is FILTERED-imminent", () => {
    expect(statusOf({phase: "competition", rank: 10, isFinalist: false, liquidated: false}))
      .toBe("FILTERED");
    expect(statusOf({phase: "competition", rank: 12, isFinalist: false, liquidated: false}))
      .toBe("FILTERED");
  });
  it("liquidated outranks every other signal", () => {
    expect(statusOf({phase: "finals", rank: 1, isFinalist: true, liquidated: true}))
      .toBe("FILTERED");
  });
  it("finalist outranks rank-derived status", () => {
    expect(statusOf({phase: "finals", rank: 12, isFinalist: true, liquidated: false}))
      .toBe("FINALIST");
  });
  it("launch phase with no rank assigned is SAFE", () => {
    expect(statusOf({phase: "launch", rank: 0, isFinalist: false, liquidated: false}))
      .toBe("SAFE");
  });
});

// ============================================================ HP component math smoke

describe("HP component shape", () => {
  it("returns the five components per token with their phase-derived weights", () => {
    const rows = [
      {id: addr(1), liquidationProceeds: null},
      {id: addr(2), liquidationProceeds: null},
    ];
    const scored = scoreCohort(rows, "competition", 0n);
    expect(scored.size).toBe(2);
    const first = scored.get(addr(1).toLowerCase())!;
    expect(first).toBeDefined();
    expect(first.components.velocity.weight).toBeCloseTo(0.4); // pre-filter weights
    expect(first.components.effectiveBuyers.weight).toBeCloseTo(0.25);
    expect(first.components.stickyLiquidity.weight).toBeCloseTo(0.15);
    expect(first.components.retention.weight).toBeCloseTo(0.1);
    expect(first.components.momentum.weight).toBeCloseTo(0.1);
    expect(first.components.velocity.score).toBeGreaterThanOrEqual(0);
    expect(first.components.velocity.score).toBeLessThanOrEqual(1);
  });

  it("finals phase swaps in the conviction-heavy weights", () => {
    const rows = [{id: addr(1), liquidationProceeds: null}];
    const scored = scoreCohort(rows, "finals", 0n);
    const c = scored.get(addr(1).toLowerCase())!.components;
    // Spec §6.5 finals: 30/15/25/20/10. Conviction (sticky+retention=0.45)
    // sits at parity with discovery (velocity+effectiveBuyers=0.45); the
    // shift from pre-filter is in *within-group* emphasis, not group totals.
    expect(c.stickyLiquidity.weight).toBeCloseTo(0.25);
    expect(c.retention.weight).toBeCloseTo(0.20);
    expect(c.velocity.weight).toBeCloseTo(0.30); // less than pre-filter 0.40
    expect(c.effectiveBuyers.weight).toBeCloseTo(0.15);
    expect(c.momentum.weight).toBeCloseTo(0.10);
  });
});

// ============================================================ Bag-lock surface

describe("/tokens — bagLock", () => {
  it("renders default `{isLocked:false, unlockTimestamp:null, creator:0x0}` when no lock recorded", async () => {
    const tokens: TokenRow[] = [mkToken({id: addr(1), symbol: "T1"})];
    const r = await getTokensHandler(
      fixtureQueries({season: mkSeason({phase: "Filter"}), tokens}),
      STARTED_AT + 12n * HOUR,
    );
    const list = r.body as unknown as Array<Record<string, unknown>>;
    const lock = list[0]!.bagLock as Record<string, unknown>;
    expect(lock.isLocked).toBe(false);
    expect(lock.unlockTimestamp).toBeNull();
    expect((lock.creator as string).toLowerCase()).toBe(
      "0x0000000000000000000000000000000000000000",
    );
  });

  it("isLocked=true when unlockTimestamp > nowSec", async () => {
    const tokens: TokenRow[] = [mkToken({id: addr(1), symbol: "T1", creator: addr(99)})];
    const r = await getTokensHandler(
      fixtureQueries({
        season: mkSeason({phase: "Filter"}),
        tokens,
        bagLocks: [
          {
            token: addr(1),
            creator: addr(99),
            unlockTimestamp: STARTED_AT + 30n * DAY, // far future
          },
        ],
      }),
      STARTED_AT + 12n * HOUR,
    );
    const list = r.body as unknown as Array<Record<string, unknown>>;
    const lock = list[0]!.bagLock as Record<string, unknown>;
    expect(lock.isLocked).toBe(true);
    expect(lock.unlockTimestamp).toBe(Number(STARTED_AT + 30n * DAY));
    expect(lock.creator).toBe(addr(99));
  });

  it("isLocked=false on a freshly-expired lock — wall-clock comparison, no re-index needed", async () => {
    const tokens: TokenRow[] = [mkToken({id: addr(1), symbol: "T1", creator: addr(99)})];
    // Lock expired 1 second before nowSec.
    const nowSec = STARTED_AT + 12n * HOUR;
    const r = await getTokensHandler(
      fixtureQueries({
        season: mkSeason({phase: "Filter"}),
        tokens,
        bagLocks: [
          {token: addr(1), creator: addr(99), unlockTimestamp: nowSec - 1n},
        ],
      }),
      nowSec,
    );
    const list = r.body as unknown as Array<Record<string, unknown>>;
    const lock = list[0]!.bagLock as Record<string, unknown>;
    expect(lock.isLocked).toBe(false);
    expect(lock.unlockTimestamp).toBe(Number(nowSec - 1n));
  });

  it("locks update on extension — the latest unlockTimestamp is what surfaces", async () => {
    // The indexer-side handler always overwrites the latest `Committed` event into
    // `creator_lock`; we model that by passing the latest row through fixture queries.
    const tokens: TokenRow[] = [mkToken({id: addr(1), symbol: "T1", creator: addr(99)})];
    const r = await getTokensHandler(
      fixtureQueries({
        season: mkSeason({phase: "Filter"}),
        tokens,
        bagLocks: [
          {token: addr(1), creator: addr(99), unlockTimestamp: STARTED_AT + 60n * DAY},
        ],
      }),
      STARTED_AT + 12n * HOUR,
    );
    const list = r.body as unknown as Array<Record<string, unknown>>;
    const lock = list[0]!.bagLock as Record<string, unknown>;
    expect(lock.unlockTimestamp).toBe(Number(STARTED_AT + 60n * DAY));
  });
});

// ============================================================ Wei → decimal ether

describe("weiToDecimalEther", () => {
  it("renders whole units without trailing zeros", () => {
    expect(weiToDecimalEther(0n)).toBe("0");
    expect(weiToDecimalEther(10n ** 18n)).toBe("1");
    expect(weiToDecimalEther(25n * 10n ** 18n)).toBe("25");
  });
  it("renders fractional values up to 6 decimals, trimmed", () => {
    expect(weiToDecimalEther(15n * 10n ** 17n)).toBe("1.5"); // 1.5 ETH
    // 14.82 ETH = 14_820_000_000_000_000_000 wei, exactly 14.82.
    expect(weiToDecimalEther(14_820_000_000_000_000_000n)).toBe("14.82");
  });
});
