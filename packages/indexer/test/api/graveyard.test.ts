/// /graveyard handler tests (Epic 1.25/1.27).
///
/// Pure-handler exercise — pins the wire shape, the near-miss margin math,
/// the sort + filter + pagination behaviours, and the "tradable" pill.

import {describe, expect, it} from "vitest";

import {
  getGraveyardDetailHandler,
  getGraveyardHandler,
  NEAR_MISS_THRESHOLD_HP,
  type GraveyardDetailQueries,
  type GraveyardQueries,
  type GraveyardResponse,
  type GraveyardSourceRow,
  type GraveyardDetailResponse,
} from "../../src/api/graveyard.js";

function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

function fixtureQueries(opts: {
  rows?: GraveyardSourceRow[];
  profiles?: Map<string, {username: string | null; avatarUrl: string | null}>;
}): GraveyardQueries {
  return {
    filteredTokens: async () => opts.rows ?? [],
    creatorProfilesFor: async (addrs) => {
      if (!opts.profiles) return new Map();
      const out = new Map<string, {username: string | null; avatarUrl: string | null}>();
      for (const a of addrs) {
        const p = opts.profiles.get(a.toLowerCase());
        if (p) out.set(a.toLowerCase(), p);
      }
      return out;
    },
  };
}

const FIXED_NOW = 1_730_000_000;
const fixedNow = (): number => FIXED_NOW;

describe("/graveyard", () => {
  it("returns 200 + empty array when no tokens are filtered", async () => {
    const r = await getGraveyardHandler(fixtureQueries({rows: []}), {}, fixedNow);
    expect(r.status).toBe(200);
    const body = r.body as GraveyardResponse;
    expect(body.tokens).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.asOf).toBe(FIXED_NOW);
    expect(body.page).toBe(1);
  });

  it("computes near-miss margin from cutLineHp - finalHp and flags isNearMiss at ≤500", async () => {
    const tokA = addr(0xa1); // margin 100 → near-miss
    const tokB = addr(0xb2); // margin 800 → not near-miss
    const tokC = addr(0xc3); // margin 0 → near-miss
    const r = await getGraveyardHandler(
      fixtureQueries({
        rows: [
          {
            address: tokA,
            symbol: "AAA",
            seasonId: 7n,
            creator: addr(0xaaa),
            isFinalist: false,
            liquidationProceeds: 10n ** 18n,
            filteredAt: 1729_000_000n,
            peakHp: 6000,
            finalHp: 4900,
            filterRound: "CUT",
            holdersAtFilter: 50,
            cutLineHp: 5000,
            finalRank: null,
          },
          {
            address: tokB,
            symbol: "BBB",
            seasonId: 7n,
            creator: addr(0xbbb),
            isFinalist: false,
            liquidationProceeds: 5n * 10n ** 17n,
            filteredAt: 1729_001_000n,
            peakHp: 5500,
            finalHp: 4200,
            filterRound: "CUT",
            holdersAtFilter: 30,
            cutLineHp: 5000,
            finalRank: null,
          },
          {
            address: tokC,
            symbol: "CCC",
            seasonId: 7n,
            creator: addr(0xccc),
            isFinalist: false,
            liquidationProceeds: 0n,
            filteredAt: 1729_002_000n,
            peakHp: 7000,
            finalHp: 5000,
            filterRound: "CUT",
            holdersAtFilter: 10,
            cutLineHp: 5000,
            finalRank: null,
          },
        ],
      }),
      {},
      fixedNow,
    );
    expect(r.status).toBe(200);
    const body = r.body as GraveyardResponse;
    expect(body.tokens).toHaveLength(3);
    const byTicker = new Map(body.tokens.map((t) => [t.ticker, t]));
    expect(byTicker.get("$AAA")?.nearMissMarginHp).toBe(100);
    expect(byTicker.get("$AAA")?.isNearMiss).toBe(true);
    expect(byTicker.get("$BBB")?.nearMissMarginHp).toBe(800);
    expect(byTicker.get("$BBB")?.isNearMiss).toBe(false);
    expect(byTicker.get("$CCC")?.nearMissMarginHp).toBe(0);
    expect(byTicker.get("$CCC")?.isNearMiss).toBe(true);
  });

  it("nearMissMarginHp clamps to 0 when finalHp > cutLineHp (data anomaly)", async () => {
    // A token whose finalHp landed above the cut line shouldn't appear in
    // this list (it survived). If a data anomaly produces this, the margin
    // clamps at 0 rather than going negative — but `isNearMiss` is false
    // (bugbot PR #103 pass-4): we don't surface a "narrowest-possible-miss"
    // narrative for a row that reflects an inconsistency rather than a real
    // close call.
    const tokA = addr(0xa1);
    const r = await getGraveyardHandler(
      fixtureQueries({
        rows: [
          {
            address: tokA,
            symbol: "AAA",
            seasonId: 7n,
            creator: addr(0xaaa),
            isFinalist: false,
            liquidationProceeds: null,
            filteredAt: 1729_000_000n,
            peakHp: 8000,
            finalHp: 6000,
            filterRound: "CUT",
            holdersAtFilter: 50,
            cutLineHp: 5000, // below finalHp
            finalRank: null,
          },
        ],
      }),
      {},
      fixedNow,
    );
    const body = r.body as GraveyardResponse;
    expect(body.tokens[0]?.nearMissMarginHp).toBe(0);
    expect(body.tokens[0]?.isNearMiss).toBe(false);
  });

  it("returns nearMissMarginHp=null when cutLineHp is null (pre-CUT season)", async () => {
    const tokA = addr(0xa1);
    const r = await getGraveyardHandler(
      fixtureQueries({
        rows: [
          {
            address: tokA,
            symbol: "AAA",
            seasonId: 8n,
            creator: addr(0xaaa),
            isFinalist: false,
            liquidationProceeds: null,
            filteredAt: 1729_000_000n,
            peakHp: 6000,
            finalHp: 4900,
            filterRound: "CUT",
            holdersAtFilter: 50,
            cutLineHp: null,
            finalRank: null,
          },
        ],
      }),
      {},
      fixedNow,
    );
    const body = r.body as GraveyardResponse;
    expect(body.tokens[0]?.nearMissMarginHp).toBeNull();
    // Spec §36.3.3 don't-change: never flag near-miss before cut has resolved.
    expect(body.tokens[0]?.isNearMiss).toBe(false);
  });

  it("plumbs finalRank from source row → response (bugbot PR #103 pass-2)", async () => {
    const r = await getGraveyardHandler(
      fixtureQueries({
        rows: [
          mkRow({address: addr(0xa1), symbol: "AAA", finalRank: 9}),
          mkRow({address: addr(0xb2), symbol: "BBB", finalRank: 11}),
          mkRow({address: addr(0xc3), symbol: "CCC", finalRank: null}),
        ],
      }),
      {},
      fixedNow,
    );
    const body = r.body as GraveyardResponse;
    const byTicker = new Map(body.tokens.map((t) => [t.ticker, t]));
    expect(byTicker.get("$AAA")?.finalRank).toBe(9);
    expect(byTicker.get("$BBB")?.finalRank).toBe(11);
    expect(byTicker.get("$CCC")?.finalRank).toBeNull();
  });

  it("?nearMiss=true filters to only near-miss rows", async () => {
    const r = await getGraveyardHandler(
      fixtureQueries({
        rows: [
          mkRow({address: addr(0xa1), symbol: "AAA", finalHp: 4900, cutLineHp: 5000}), // 100 → near
          mkRow({address: addr(0xb2), symbol: "BBB", finalHp: 4200, cutLineHp: 5000}), // 800 → not
          mkRow({address: addr(0xc3), symbol: "CCC", finalHp: 4501, cutLineHp: 5000}), // 499 → near
        ],
      }),
      {nearMiss: "true"},
      fixedNow,
    );
    const body = r.body as GraveyardResponse;
    expect(body.tokens.map((t) => t.ticker).sort()).toEqual(["$AAA", "$CCC"]);
  });

  it("?season=7 filters by seasonId", async () => {
    const r = await getGraveyardHandler(
      fixtureQueries({
        rows: [
          mkRow({address: addr(0xa1), symbol: "AAA", seasonId: 7n}),
          mkRow({address: addr(0xb2), symbol: "BBB", seasonId: 8n}),
        ],
      }),
      {season: "7"},
      fixedNow,
    );
    const body = r.body as GraveyardResponse;
    expect(body.tokens.map((t) => t.season)).toEqual([7]);
  });

  it("?creator=<address> filters by creator", async () => {
    const creator = addr(0xcafe);
    const r = await getGraveyardHandler(
      fixtureQueries({
        rows: [
          mkRow({address: addr(0xa1), symbol: "AAA", creator}),
          mkRow({address: addr(0xb2), symbol: "BBB", creator: addr(0xdead)}),
        ],
      }),
      {creator},
      fixedNow,
    );
    const body = r.body as GraveyardResponse;
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]?.creator).toBe(creator);
  });

  it("?ticker=DOO filters by symbol substring (case-insensitive, ignores leading $)", async () => {
    const r = await getGraveyardHandler(
      fixtureQueries({
        rows: [
          mkRow({address: addr(0xa1), symbol: "DOOM"}),
          mkRow({address: addr(0xb2), symbol: "ZZZ"}),
        ],
      }),
      {ticker: "doo"},
      fixedNow,
    );
    const body = r.body as GraveyardResponse;
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]?.ticker).toBe("$DOOM");
  });

  it("?sort=nearMissMargin sorts smallest-margin-first; nulls last", async () => {
    const r = await getGraveyardHandler(
      fixtureQueries({
        rows: [
          mkRow({address: addr(0xa1), symbol: "AAA", finalHp: 4900, cutLineHp: 5000}), // 100
          mkRow({address: addr(0xb2), symbol: "BBB", finalHp: 4500, cutLineHp: 5000}), // 500
          mkRow({address: addr(0xc3), symbol: "CCC", finalHp: 4000, cutLineHp: 5000}), // 1000
          mkRow({address: addr(0xd4), symbol: "DDD", finalHp: 3000, cutLineHp: null}), // null
        ],
      }),
      {sort: "nearMissMargin"},
      fixedNow,
    );
    const body = r.body as GraveyardResponse;
    expect(body.tokens.map((t) => t.ticker)).toEqual(["$AAA", "$BBB", "$CCC", "$DDD"]);
  });

  it("?sort=peakHp sorts highest-peak first", async () => {
    const r = await getGraveyardHandler(
      fixtureQueries({
        rows: [
          mkRow({address: addr(0xa1), symbol: "AAA", peakHp: 5000}),
          mkRow({address: addr(0xb2), symbol: "BBB", peakHp: 8000}),
          mkRow({address: addr(0xc3), symbol: "CCC", peakHp: 3000}),
        ],
      }),
      {sort: "peakHp"},
      fixedNow,
    );
    const body = r.body as GraveyardResponse;
    expect(body.tokens.map((t) => t.ticker)).toEqual(["$BBB", "$AAA", "$CCC"]);
  });

  it("?sort=recent (default) sorts most-recent filteredAt first", async () => {
    const r = await getGraveyardHandler(
      fixtureQueries({
        rows: [
          mkRow({address: addr(0xa1), symbol: "AAA", filteredAt: 100n}),
          mkRow({address: addr(0xb2), symbol: "BBB", filteredAt: 300n}),
          mkRow({address: addr(0xc3), symbol: "CCC", filteredAt: 200n}),
        ],
      }),
      {},
      fixedNow,
    );
    const body = r.body as GraveyardResponse;
    expect(body.tokens.map((t) => t.ticker)).toEqual(["$BBB", "$CCC", "$AAA"]);
  });

  it("rejects unknown sort with 400", async () => {
    const r = await getGraveyardHandler(fixtureQueries({}), {sort: "wat"}, fixedNow);
    expect(r.status).toBe(400);
  });

  it("rejects perPage > 200 with 400", async () => {
    const r = await getGraveyardHandler(
      fixtureQueries({}),
      {perPage: "500"},
      fixedNow,
    );
    expect(r.status).toBe(400);
  });

  it("paginates: page=2 + perPage=2 returns rows[2..3]", async () => {
    const rows: GraveyardSourceRow[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push(
        mkRow({
          address: addr(0xa0 + i),
          symbol: `T${i}`,
          filteredAt: BigInt(1000 + i),
        }),
      );
    }
    const r = await getGraveyardHandler(
      fixtureQueries({rows}),
      {page: "2", perPage: "2"},
      fixedNow,
    );
    const body = r.body as GraveyardResponse;
    expect(body.total).toBe(6);
    expect(body.page).toBe(2);
    expect(body.perPage).toBe(2);
    expect(body.tokens).toHaveLength(2);
    // Sorted by recent → highest filteredAt first → T5, T4 on page 1; T3, T2 on page 2.
    expect(body.tokens.map((t) => t.ticker)).toEqual(["$T3", "$T2"]);
  });

  it("decorates creator profiles when identity layer answers", async () => {
    const creator = addr(0xcafe);
    const profiles = new Map([
      [creator.toLowerCase(), {username: "starbreaker", avatarUrl: null}],
    ]);
    const r = await getGraveyardHandler(
      fixtureQueries({
        rows: [mkRow({address: addr(0xa1), symbol: "AAA", creator})],
        profiles,
      }),
      {},
      fixedNow,
    );
    const body = r.body as GraveyardResponse;
    expect(body.tokens[0]?.creatorUsername).toBe("starbreaker");
  });

  it("tradableNow is true on every row (spec §36.1.2 contract-level invariant)", async () => {
    const r = await getGraveyardHandler(
      fixtureQueries({
        rows: [
          mkRow({address: addr(0xa1), symbol: "AAA"}),
          mkRow({address: addr(0xb2), symbol: "BBB"}),
        ],
      }),
      {},
      fixedNow,
    );
    const body = r.body as GraveyardResponse;
    expect(body.tokens.every((t) => t.tradableNow)).toBe(true);
  });

  it("NEAR_MISS_THRESHOLD_HP is 500 (spec §36.3.3 5pp on int10k scale)", () => {
    expect(NEAR_MISS_THRESHOLD_HP).toBe(500);
  });
});

// ============================================================ /graveyard/:address

function mkRow(opts: Partial<GraveyardSourceRow>): GraveyardSourceRow {
  return {
    address: opts.address ?? addr(0xa1),
    symbol: opts.symbol ?? "TEST",
    seasonId: opts.seasonId ?? 7n,
    creator: opts.creator ?? addr(0xaaa),
    isFinalist: opts.isFinalist ?? false,
    liquidationProceeds: opts.liquidationProceeds ?? null,
    filteredAt: opts.filteredAt ?? 1729_000_000n,
    peakHp: opts.peakHp ?? 5000,
    finalHp: opts.finalHp ?? 3000,
    filterRound: opts.filterRound ?? "CUT",
    holdersAtFilter: opts.holdersAtFilter ?? 0,
    cutLineHp: opts.cutLineHp ?? 5000,
    finalRank: opts.finalRank ?? null,
  };
}

function detailFixture(overrides: Partial<{
  liquidated: boolean;
  hpSeries: Array<{timestamp: bigint; hp: number; trigger: string}>;
  holderSeries: Array<{timestamp: bigint; holders: number}>;
  lpEvents: Array<{timestamp: bigint; kind: "MINT" | "BURN"; amountWeth: bigint}>;
  cutLine: number | null;
  finalRank: number | null;
}> = {}): GraveyardDetailQueries {
  return {
    tokenAndSeason: async () => ({
      token: {
        address: addr(0xa1),
        symbol: "DOOM",
        name: "Doom",
        creator: addr(0xaaa),
        seasonId: 7n,
        isProtocolLaunched: false,
        isFinalist: false,
        liquidated: overrides.liquidated ?? true,
        createdAt: 1728_000_000n,
      },
      season: {
        id: 7n,
        startedAt: 1728_000_000n,
        finalizedAt: 1729_000_000n,
        winner: addr(0x111),
      },
    }),
    hpSeriesForToken: async () =>
      overrides.hpSeries ?? [
        {timestamp: 1728_001_000n, hp: 1000, trigger: "BLOCK_TICK"},
        {timestamp: 1728_500_000n, hp: 6000, trigger: "BLOCK_TICK"}, // peak
        {timestamp: 1729_000_000n, hp: 4900, trigger: "CUT"},
      ],
    holderSeriesForToken: async () =>
      overrides.holderSeries ?? [
        {timestamp: 1728_500_000n, holders: 412},
        {timestamp: 1729_000_000n, holders: 287},
      ],
    lpEventsForToken: async () =>
      overrides.lpEvents ?? [
        {timestamp: 1729_000_000n, kind: "BURN", amountWeth: 5n * 10n ** 17n},
      ],
    cutLineForSeason: async () => overrides.cutLine ?? 5000,
    finalRankForToken: async () => overrides.finalRank ?? 11,
    creatorProfile: async () => ({username: "starbreaker", avatarUrl: null}),
  };
}

describe("/graveyard/:address", () => {
  it("rejects malformed address with 400", async () => {
    const r = await getGraveyardDetailHandler(detailFixture(), "garbage");
    expect(r.status).toBe(400);
  });

  it("returns 404 for tokens that aren't filtered", async () => {
    const r = await getGraveyardDetailHandler(
      detailFixture({liquidated: false}),
      addr(0xa1),
    );
    expect(r.status).toBe(404);
  });

  it("computes lifecycle: peakHp + peakHpAt + finalHp + nearMissMarginHp", async () => {
    const r = await getGraveyardDetailHandler(detailFixture(), addr(0xa1));
    expect(r.status).toBe(200);
    const body = r.body as GraveyardDetailResponse;
    expect(body.lifecycle.peakHp).toBe(6000);
    expect(body.lifecycle.peakHpAt).toBe(1728_500_000);
    expect(body.lifecycle.finalHp).toBe(4900);
    expect(body.lifecycle.filterRound).toBe("CUT");
    expect(body.lifecycle.nearMissMarginHp).toBe(100);
    expect(body.lifecycle.isNearMiss).toBe(true);
  });

  it("samples holders at peak + at filter", async () => {
    const r = await getGraveyardDetailHandler(detailFixture(), addr(0xa1));
    const body = r.body as GraveyardDetailResponse;
    expect(body.lifecycle.holdersAtPeak).toBe(412);
    expect(body.lifecycle.holdersAtFilter).toBe(287);
    expect(body.lifecycle.holdersAtLaunch).toBe(0);
  });

  it("populates hpTrajectory + holderTrajectory + lpEvents arrays", async () => {
    const r = await getGraveyardDetailHandler(detailFixture(), addr(0xa1));
    const body = r.body as GraveyardDetailResponse;
    expect(body.hpTrajectory).toHaveLength(3);
    expect(body.hpTrajectory[0]?.hp).toBe(1000);
    expect(body.holderTrajectory).toHaveLength(2);
    expect(body.lpEvents).toHaveLength(1);
    expect(body.lpEvents[0]?.kind).toBe("BURN");
    expect(body.lpEvents[0]?.amountWeth).toBe("0.5");
  });

  it("tradableNow is always true (spec §36.1.2)", async () => {
    const r = await getGraveyardDetailHandler(detailFixture(), addr(0xa1));
    const body = r.body as GraveyardDetailResponse;
    expect(body.tradableNow).toBe(true);
  });

  it("isNearMiss=false on cutLineHp anomaly — symmetric with index (bugbot pass-6)", async () => {
    // finalHp > cutLineHp ⇒ raw margin negative ⇒ clamp to 0. The detail
    // handler must return the same isNearMiss=false as decorateRow on the
    // index, otherwise the same token contradicts itself across surfaces.
    const r = await getGraveyardDetailHandler(
      detailFixture({
        hpSeries: [
          {timestamp: 1728_500_000n, hp: 6000, trigger: "BLOCK_TICK"},
          // CUT-tagged finalHp=6000 sits above the cut line — a data anomaly.
          {timestamp: 1729_000_000n, hp: 6000, trigger: "CUT"},
        ],
        cutLine: 5000,
      }),
      addr(0xa1),
    );
    const body = r.body as GraveyardDetailResponse;
    expect(body.lifecycle.nearMissMarginHp).toBe(0);
    expect(body.lifecycle.isNearMiss).toBe(false);
  });
});
