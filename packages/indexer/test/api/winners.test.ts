/// /winners + /winners/:address/metrics handler tests (Epic 1.26/1.27).
///
/// Pure-handler exercise — pins squeaker margin math (winningHp - secondPlaceHp ≤
/// 500), the wire shape of both endpoints, and the runner-up cross-link.

import {describe, expect, it} from "vitest";

import {
  getWinnerMetricsHandler,
  getWinnersHandler,
  type WinnerMetricsQueries,
  type WinnerMetricsResponse,
  type WinnerSourceRow,
  type WinnersQueries,
  type WinnersResponse,
} from "../../src/api/winners.js";

function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

function fixtureQueries(opts: {
  rows?: WinnerSourceRow[];
  profiles?: Map<string, {username: string | null; avatarUrl: string | null}>;
}): WinnersQueries {
  return {
    winnerTokens: async () => opts.rows ?? [],
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

function mkWinner(opts: Partial<WinnerSourceRow>): WinnerSourceRow {
  return {
    address: opts.address ?? addr(0xa1),
    symbol: opts.symbol ?? "FILTER",
    seasonId: opts.seasonId ?? 1n,
    creator: opts.creator ?? addr(0xaaa),
    // Discriminate null (explicit "no settlement / no second place") from
    // undefined (caller didn't override). `??` collapses both, which would
    // hide the single-token-finale case behind the default 8180.
    settledAt: "settledAt" in opts ? opts.settledAt ?? null : 1729_000_000n,
    winningHp: opts.winningHp ?? 8420,
    secondPlaceHp: "secondPlaceHp" in opts ? opts.secondPlaceHp ?? null : 8180,
    currentReserveWei: opts.currentReserveWei ?? 0n,
    currentMcapWei: opts.currentMcapWei ?? 0n,
  };
}

describe("/winners", () => {
  it("returns 200 + empty winners[] when no seasons have finalized", async () => {
    const r = await getWinnersHandler(fixtureQueries({rows: []}));
    expect(r.status).toBe(200);
    expect(r.body.winners).toEqual([]);
    expect(r.body.total).toBe(0);
  });

  it("computes winMarginHp = winningHp - secondPlaceHp", async () => {
    const r = await getWinnersHandler(
      fixtureQueries({
        rows: [mkWinner({winningHp: 8420, secondPlaceHp: 8180})],
      }),
    );
    expect(r.body.winners[0]?.winMarginHp).toBe(240);
  });

  it("flags isSqueaker=true for winMarginHp ≤ 500", async () => {
    const r = await getWinnersHandler(
      fixtureQueries({
        rows: [
          mkWinner({address: addr(0xa1), symbol: "AAA", winningHp: 8420, secondPlaceHp: 8180}), // 240 → sq
          mkWinner({address: addr(0xb2), symbol: "BBB", winningHp: 9000, secondPlaceHp: 8000}), // 1000 → not
          mkWinner({address: addr(0xc3), symbol: "CCC", winningHp: 8500, secondPlaceHp: 8000}), // 500 → sq
          mkWinner({address: addr(0xd4), symbol: "DDD", winningHp: 8501, secondPlaceHp: 8000}), // 501 → not
        ],
      }),
    );
    const byTicker = new Map(r.body.winners.map((w) => [w.ticker, w]));
    expect(byTicker.get("$AAA")?.isSqueaker).toBe(true);
    expect(byTicker.get("$BBB")?.isSqueaker).toBe(false);
    expect(byTicker.get("$CCC")?.isSqueaker).toBe(true);
    expect(byTicker.get("$DDD")?.isSqueaker).toBe(false);
  });

  it("returns winMarginHp=null + isSqueaker=false when secondPlaceHp is null (single-token finale)", async () => {
    const r = await getWinnersHandler(
      fixtureQueries({
        rows: [mkWinner({secondPlaceHp: null})],
      }),
    );
    expect(r.body.winners[0]?.winMarginHp).toBeNull();
    expect(r.body.winners[0]?.isSqueaker).toBe(false);
  });

  it("suppresses winMarginHp + isSqueaker when raw margin would be negative (anomaly clamp)", async () => {
    const r = await getWinnersHandler(
      fixtureQueries({
        rows: [mkWinner({winningHp: 0, secondPlaceHp: 8000})],
      }),
    );
    expect(r.body.winners[0]?.winMarginHp).toBeNull();
    expect(r.body.winners[0]?.isSqueaker).toBe(false);
  });

  it("sorts by settledAt descending (most recent first)", async () => {
    const r = await getWinnersHandler(
      fixtureQueries({
        rows: [
          mkWinner({address: addr(0xa1), symbol: "AAA", settledAt: 100n}),
          mkWinner({address: addr(0xb2), symbol: "BBB", settledAt: 300n}),
          mkWinner({address: addr(0xc3), symbol: "CCC", settledAt: 200n}),
        ],
      }),
    );
    expect(r.body.winners.map((w) => w.ticker)).toEqual(["$BBB", "$CCC", "$AAA"]);
  });

  it("decorates creator profile when identity layer answers", async () => {
    const creator = addr(0xcafe);
    const profiles = new Map([
      [creator.toLowerCase(), {username: "starbreaker", avatarUrl: null}],
    ]);
    const r = await getWinnersHandler(
      fixtureQueries({
        rows: [mkWinner({creator})],
        profiles,
      }),
    );
    expect(r.body.winners[0]?.creatorUsername).toBe("starbreaker");
  });

  it("formats currentReserveWeth + currentMcapWeth as decimal-ether", async () => {
    const r = await getWinnersHandler(
      fixtureQueries({
        rows: [
          mkWinner({
            currentReserveWei: 12n * 10n ** 18n + 4n * 10n ** 17n, // 12.4
            currentMcapWei: 47n * 10n ** 18n + 3n * 10n ** 17n, // 47.3
          }),
        ],
      }),
    );
    expect(r.body.winners[0]?.currentReserveWeth).toBe("12.4");
    expect(r.body.winners[0]?.currentMcapWeth).toBe("47.3");
  });
});

// ============================================================ /winners/:address/metrics

function metricsFixture(overrides: Partial<{
  summary: Awaited<ReturnType<WinnerMetricsQueries["winnerSummary"]>>;
  runnerUp: Awaited<ReturnType<WinnerMetricsQueries["runnerUpForSeason"]>>;
}> = {}): WinnerMetricsQueries {
  return {
    winnerSummary: async (a) =>
      "summary" in overrides
        ? overrides.summary ?? null
        : {
            address: a,
            symbol: "FILTER",
            name: "Filter Token",
            seasonId: 1n,
            creator: addr(0xaaa),
            settledAt: 1729_000_000n,
            winningHp: 8420,
          },
    runnerUpForSeason: async () =>
      overrides.runnerUp === undefined
        ? {
            address: addr(0xb2),
            symbol: "BLOOD",
            creator: addr(0xbbb),
            finalHp: 8180,
          }
        : overrides.runnerUp,
    reserveSeriesForToken: async () => [
      {timestamp: 1729_000_000n, reserveWei: 970_000_000_000_000_000n}, // 0.97
      {timestamp: 1729_604_800n, reserveWei: 1_210_000_000_000_000_000n}, // 1.21
    ],
    feeAccrualSeries: async () => [
      {
        timestamp: 1729_000_000n,
        creatorEarnedWei: 12_000_000_000_000_000n, // 0.012
        polTopUpWei: 57_000_000_000_000_000n, // 0.057
      },
    ],
    holderRetentionSeries: async () => [
      {timestamp: 1729_000_000n, activeHolders: 412, fromOriginal: 412},
      {timestamp: 1729_604_800n, activeHolders: 387, fromOriginal: 308},
    ],
    creatorProfile: async (a) => {
      if (a === addr(0xaaa)) return {username: "starbreaker", avatarUrl: null};
      return null;
    },
  };
}

describe("/winners/:address/metrics", () => {
  it("rejects malformed address with 400", async () => {
    const r = await getWinnerMetricsHandler(metricsFixture(), "garbage");
    expect(r.status).toBe(400);
  });

  it("returns 404 when address isn't a known winner", async () => {
    const r = await getWinnerMetricsHandler(
      metricsFixture({summary: null}),
      addr(0xa1),
    );
    expect(r.status).toBe(404);
  });

  it("returns full winner metrics shape with squeaker callout for ≤500 margin", async () => {
    const r = await getWinnerMetricsHandler(metricsFixture(), addr(0xa1));
    expect(r.status).toBe(200);
    const body = r.body as WinnerMetricsResponse;
    expect(body.token.ticker).toBe("$FILTER");
    expect(body.winningHp).toBe(8420);
    expect(body.secondPlaceHp).toBe(8180);
    expect(body.winMarginHp).toBe(240);
    expect(body.isSqueaker).toBe(true);
    expect(body.secondPlace?.ticker).toBe("$BLOOD");
    expect(body.secondPlace?.finalHp).toBe(8180);
  });

  it("isSqueaker=false when winMarginHp > 500", async () => {
    const r = await getWinnerMetricsHandler(
      {
        ...metricsFixture(),
        runnerUpForSeason: async () => ({
          address: addr(0xb2),
          symbol: "BLOOD",
          creator: addr(0xbbb),
          finalHp: 7000, // margin = 1420
        }),
      },
      addr(0xa1),
    );
    const body = r.body as WinnerMetricsResponse;
    expect(body.winMarginHp).toBe(1420);
    expect(body.isSqueaker).toBe(false);
  });

  it("suppresses winMarginHp + isSqueaker when raw margin would be negative (anomaly clamp)", async () => {
    // Mirrors the /winners list-endpoint clamp: indexer-lag may yield
    // winningHp < runnerUp.finalHp; the two endpoints must agree.
    const r = await getWinnerMetricsHandler(
      {
        ...metricsFixture({
          summary: {
            address: addr(0xa1),
            symbol: "FILTER",
            name: "Filter Token",
            seasonId: 1n,
            creator: addr(0xaaa),
            settledAt: 1729_000_000n,
            winningHp: 0, // anomalous default
          },
        }),
      },
      addr(0xa1),
    );
    const body = r.body as WinnerMetricsResponse;
    expect(body.winMarginHp).toBeNull();
    expect(body.isSqueaker).toBe(false);
  });

  it("populates reserveGrowth as decimal-ether", async () => {
    const r = await getWinnerMetricsHandler(metricsFixture(), addr(0xa1));
    const body = r.body as WinnerMetricsResponse;
    expect(body.reserveGrowth).toHaveLength(2);
    expect(body.reserveGrowth[0]?.reserveWeth).toBe("0.97");
    expect(body.reserveGrowth[1]?.reserveWeth).toBe("1.21");
  });

  it("populates feeAccrual with creator + pol slices", async () => {
    const r = await getWinnerMetricsHandler(metricsFixture(), addr(0xa1));
    const body = r.body as WinnerMetricsResponse;
    expect(body.feeAccrual).toHaveLength(1);
    expect(body.feeAccrual[0]?.creatorEarnedWeth).toBe("0.012");
    expect(body.feeAccrual[0]?.polTopUpWeth).toBe("0.057");
  });

  it("populates holderRetention with activeHolders + fromOriginal", async () => {
    const r = await getWinnerMetricsHandler(metricsFixture(), addr(0xa1));
    const body = r.body as WinnerMetricsResponse;
    expect(body.holderRetention).toHaveLength(2);
    expect(body.holderRetention[0]).toEqual({
      timestamp: 1729_000_000,
      activeHolders: 412,
      fromOriginal: 412,
    });
    expect(body.holderRetention[1]?.fromOriginal).toBe(308);
  });

  it("returns secondPlace=null when no runner-up exists", async () => {
    const r = await getWinnerMetricsHandler(
      {
        ...metricsFixture(),
        runnerUpForSeason: async () => null,
      },
      addr(0xa1),
    );
    const body = r.body as WinnerMetricsResponse;
    expect(body.secondPlace).toBeNull();
    expect(body.secondPlaceHp).toBeNull();
    expect(body.winMarginHp).toBeNull();
    expect(body.isSqueaker).toBe(false);
  });
});
