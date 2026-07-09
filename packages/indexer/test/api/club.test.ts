/// Tests for the `/club` pure handler — Epic 2.6 / spec §47.3.8.

import {describe, expect, it} from "vitest";

import {
  CLUB_CREDITS_PER_TOKEN,
  getClubHandler,
  type ClubQueries,
  type ClubConfig,
} from "../../src/api/club.js";

const GENESIS_CONFIG: ClubConfig = {maxSupply: 250, mintPriceWei: "50000000000000000"};

function queriesOf(overrides: Partial<ClubQueries>): ClubQueries {
  return {
    stats: async () => null,
    passes: async () => [],
    recentRedemptions: async () => [],
    ...overrides,
  };
}

describe("getClubHandler", () => {
  it("returns the zero-state pre-deploy (always 200 per the endpoint-status contract)", async () => {
    const r = await getClubHandler(queriesOf({}), {maxSupply: 0, mintPriceWei: "0"});
    expect(r.status).toBe(200);
    expect(r.body.minted).toBe(0);
    expect(r.body.maxSupply).toBe(0);
    expect(r.body.credits).toEqual({issued: 0, consumed: 0, reclaimed: 0, outstanding: 0});
    expect(r.body.holders).toEqual([]);
    expect(r.body.recentRedemptions).toEqual([]);
  });

  it("aggregates the holder roster by current owner and sums credits", async () => {
    const r = await getClubHandler(
      queriesOf({
        stats: async () => ({
          minted: 3,
          proceedsWei: 150_000_000_000_000_000n,
          creditsConsumed: 1,
          creditsReclaimed: 0,
        }),
        passes: async () => [
          {id: 1n, owner: "0xaaa1", creditsRemaining: 2},
          {id: 3n, owner: "0xaaa1", creditsRemaining: 1},
          {id: 2n, owner: "0xbbb2", creditsRemaining: 2},
        ] as never,
      }),
      GENESIS_CONFIG,
    );
    expect(r.body.minted).toBe(3);
    expect(r.body.proceedsWei).toBe("150000000000000000");
    expect(r.body.holders).toEqual([
      {address: "0xaaa1", tokenIds: [1, 3], creditsRemaining: 3},
      {address: "0xbbb2", tokenIds: [2], creditsRemaining: 2},
    ]);
  });

  it("computes outstanding credits = issued − consumed + reclaimed", async () => {
    const r = await getClubHandler(
      queriesOf({
        stats: async () => ({
          minted: 10,
          proceedsWei: 0n,
          creditsConsumed: 4,
          creditsReclaimed: 1,
        }),
      }),
      GENESIS_CONFIG,
    );
    expect(r.body.credits.issued).toBe(10 * CLUB_CREDITS_PER_TOKEN);
    expect(r.body.credits.outstanding).toBe(20 - 4 + 1);
  });

  it("serializes redemption rows with numeric ids and nullable reclaimedAt", async () => {
    const r = await getClubHandler(
      queriesOf({
        recentRedemptions: async () => [
          {
            seasonId: 2n,
            creator: "0xcafe" as `0x${string}`,
            tokenId: 7n,
            status: "RECLAIMED",
            consumedAt: 1_700_000_000n,
            reclaimedAt: 1_700_000_500n,
          },
          {
            seasonId: 2n,
            creator: "0xbeef" as `0x${string}`,
            tokenId: 9n,
            status: "CONSUMED",
            consumedAt: 1_700_000_100n,
            reclaimedAt: null,
          },
        ],
      }),
      GENESIS_CONFIG,
    );
    expect(r.body.recentRedemptions).toEqual([
      {
        seasonId: 2,
        creator: "0xcafe",
        tokenId: 7,
        status: "RECLAIMED",
        consumedAt: 1_700_000_000,
        reclaimedAt: 1_700_000_500,
      },
      {
        seasonId: 2,
        creator: "0xbeef",
        tokenId: 9,
        status: "CONSUMED",
        consumedAt: 1_700_000_100,
        reclaimedAt: null,
      },
    ]);
  });
});
