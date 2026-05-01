/// /profile/:address handler tests.
///
/// Pure handler exercise — the route wiring (cache + rate-limit + Drizzle adapter) is
/// covered by the middleware tests; this file just pins the wire shape and badge logic.

import {describe, expect, it} from "vitest";

import {
  getProfileHandler,
  type ClaimSums,
  type CreatedTokenRow,
  type ProfileQueries,
  type ProfileResponse,
} from "../../src/api/profile.js";

const FIXED_NOW = new Date("2026-04-30T22:00:00.000Z");
const fixedNow = (): Date => FIXED_NOW;

function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

function fixtureQueries(opts: {
  created?: CreatedTokenRow[];
  claims?: ClaimSums;
}): ProfileQueries {
  return {
    createdTokensByCreator: async () => opts.created ?? [],
    claimSumsForUser: async () => opts.claims ?? {rolloverEarnedWei: 0n, bonusEarnedWei: 0n},
  };
}

describe("/profile/:address", () => {
  it("rejects malformed address with 400", async () => {
    const r = await getProfileHandler(fixtureQueries({}), "not-an-address", fixedNow);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({error: "invalid address"});
  });

  it("normalizes mixed-case address to lowercase before lookup", async () => {
    const lower = addr(0xabcd);
    let queriedWith: `0x${string}` | null = null;
    const q: ProfileQueries = {
      createdTokensByCreator: async (a) => {
        queriedWith = a;
        return [];
      },
      claimSumsForUser: async () => ({rolloverEarnedWei: 0n, bonusEarnedWei: 0n}),
    };
    const upper = lower.toUpperCase().replace("0X", "0x");
    const r = await getProfileHandler(q, upper, fixedNow);
    expect(r.status).toBe(200);
    expect(queriedWith).toBe(lower);
    expect((r.body as ProfileResponse).address).toBe(lower);
  });

  it("unknown wallet returns 200 with all-zero shape (not 404)", async () => {
    // Spec §22: avoid leaking "is this address ever been a player" via status code, and
    // the Arena profile UI wants to render an empty profile for new wallets.
    const r = await getProfileHandler(fixtureQueries({}), addr(1), fixedNow);
    expect(r.status).toBe(200);
    const body = r.body as ProfileResponse;
    expect(body.createdTokens).toEqual([]);
    expect(body.stats.wins).toBe(0);
    expect(body.stats.rolloverEarnedWei).toBe("0");
    expect(body.stats.bonusEarnedWei).toBe("0");
    expect(body.stats.filtersSurvived).toBe(0);
    expect(body.stats.lifetimeTradeVolumeWei).toBe("0");
    expect(body.stats.tokensTraded).toBe(0);
    expect(body.badges).toEqual([]);
    expect(body.computedAt).toBe(FIXED_NOW.toISOString());
  });

  it("creator wallet: maps WEEKLY_WINNER status when token is its season's winner", async () => {
    const tokA = addr(0xa1);
    const tokB = addr(0xb2);
    const r = await getProfileHandler(
      fixtureQueries({
        created: [
          {
            id: tokA,
            symbol: "EDGE",
            seasonId: 1n,
            liquidated: false,
            isFinalist: true,
            createdAt: 1_700_000_000n,
            seasonWinner: tokA, // this season's winner — WEEKLY_WINNER
            rank: 1,
          },
          {
            id: tokB,
            symbol: "$RIM",
            seasonId: 2n,
            liquidated: false,
            isFinalist: false,
            createdAt: 1_700_086_400n,
            seasonWinner: addr(0xff), // someone else won — ACTIVE
            rank: 4,
          },
        ],
      }),
      addr(0xcafe),
      fixedNow,
    );
    expect(r.status).toBe(200);
    const body = r.body as ProfileResponse;
    expect(body.createdTokens).toHaveLength(2);
    expect(body.createdTokens[0]?.status).toBe("WEEKLY_WINNER");
    expect(body.createdTokens[0]?.ticker).toBe("$EDGE"); // $-prefix added
    expect(body.createdTokens[1]?.status).toBe("ACTIVE");
    expect(body.createdTokens[1]?.ticker).toBe("$RIM"); // already had $; not double-prefixed
    expect(body.stats.wins).toBe(1);
    expect(body.badges).toEqual(["CHAMPION_CREATOR"]);
  });

  it("liquidated tokens map to FILTERED regardless of finalist flag", async () => {
    const r = await getProfileHandler(
      fixtureQueries({
        created: [
          {
            id: addr(0x1),
            symbol: "DUST",
            seasonId: 1n,
            liquidated: true,
            isFinalist: true, // shouldn't matter
            createdAt: 1_700_000_000n,
            seasonWinner: null,
            rank: null,
          },
        ],
      }),
      addr(0xbeef),
      fixedNow,
    );
    const body = r.body as ProfileResponse;
    expect(body.createdTokens[0]?.status).toBe("FILTERED");
    expect(body.stats.wins).toBe(0);
    // CHAMPION_CREATOR doesn't fire on a filtered token, even if its creator made others.
    expect(body.badges).toEqual([]);
  });

  it("holder wallet: aggregates rollover + bonus claim sums into wei-string stats", async () => {
    const r = await getProfileHandler(
      fixtureQueries({
        claims: {
          rolloverEarnedWei: 12_345n * 10n ** 15n, // arbitrary positive
          bonusEarnedWei: 777n * 10n ** 18n, // 777 ETH-equivalent
        },
      }),
      addr(0xc0de),
      fixedNow,
    );
    const body = r.body as ProfileResponse;
    expect(body.stats.rolloverEarnedWei).toBe((12_345n * 10n ** 15n).toString());
    expect(body.stats.bonusEarnedWei).toBe((777n * 10n ** 18n).toString());
  });

  it("WEEKLY_WINNER detection is case-insensitive on the seasonWinner address", async () => {
    // Regression guard: indexer schema stores lowercase but a future writer (or test
    // double) could leak a checksum-cased address through. The status mapping must not
    // depend on case.
    const tok = addr(0xabc);
    const r = await getProfileHandler(
      fixtureQueries({
        created: [
          {
            id: tok,
            symbol: "WIN",
            seasonId: 1n,
            liquidated: false,
            isFinalist: true,
            createdAt: 1_700_000_000n,
            seasonWinner: tok.toUpperCase().replace("0X", "0x") as `0x${string}`,
            rank: 1,
          },
        ],
      }),
      addr(0xcafe),
      fixedNow,
    );
    expect((r.body as ProfileResponse).createdTokens[0]?.status).toBe("WEEKLY_WINNER");
  });

  it("computedAt always reflects the injected clock, not Date.now()", async () => {
    const r = await getProfileHandler(fixtureQueries({}), addr(1), fixedNow);
    expect((r.body as ProfileResponse).computedAt).toBe(FIXED_NOW.toISOString());
  });
});
