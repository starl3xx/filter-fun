/// Audit H-2 (Phase 1, 2026-05-01) regression — endpoint status convention.
///
/// Convention pinned (mirrors `handlers.ts` top-of-file comment):
///   /season           200 + {status: "not-ready", season: null}  when no season
///   /tokens           200 + []                                   when no season
///   /token/:address   404                                        when address unknown
///   /profile/:address 200 + empty profile                        always (privacy §22)
///
/// Pre-fix /season returned 404; this test fails until the convention is enforced.
import {describe, expect, it} from "vitest";

import {
  getSeasonHandler,
  getTokenDetailHandler,
  getTokensHandler,
  type ApiQueries,
  type TokenDetailRow,
} from "../../../src/api/handlers.js";
import {getProfileHandler, type ProfileQueries} from "../../../src/api/profile.js";

function emptyQueries(): ApiQueries {
  return {
    latestSeason: async () => null,
    publicLaunchCount: async () => 0,
    tokensInSeason: async () => [],
    tokenByAddress: async () => null,
    bagLocksForTokens: async () => [],
  };
}

function emptyProfileQueries(): ProfileQueries {
  return {
    createdTokensByCreator: async () => [],
    claimSumsForUser: async () => ({rolloverEarnedWei: 0n, bonusEarnedWei: 0n}),
    swapAggregatesForUser: async () => ({lifetimeTradeVolumeWei: 0n, tokensTraded: 0}),
    holderBadgeFlagsForUser: async () => ({weekWinner: false, filterSurvivor: false, filtersSurvived: 0}),
    tournamentBadgeFlagsForUser: async () => ({
      quarterlyFinalist: false,
      quarterlyChampion: false,
      annualFinalist: false,
      annualChampion: false,
    }),
  };
}

describe("endpoint status convention (Audit H-2)", () => {
  it("/season returns 200 + status:not-ready when no season is indexed", async () => {
    const r = await getSeasonHandler(emptyQueries());
    // Pre-fix: status 404. Post-fix: 200 + envelope.
    expect(r.status).toBe(200);
    expect(r.body).toEqual({status: "not-ready", season: null});
  });

  it("/tokens returns 200 + [] when no season is indexed (collections convention)", async () => {
    const r = await getTokensHandler(emptyQueries(), 0n);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("/token/:address returns 404 for an unknown address (named-singleton convention)", async () => {
    const r = await getTokenDetailHandler(
      emptyQueries(),
      "0x0000000000000000000000000000000000000099",
    );
    expect(r.status).toBe(404);
  });

  it("/token/:address returns 200 for a known address (cohort sanity check)", async () => {
    const known: TokenDetailRow = {
      id: "0x0000000000000000000000000000000000000001",
      symbol: "FILTER",
      isFinalist: true,
      liquidated: false,
      liquidationProceeds: null,
      // Audit M-Indexer-1: creator now required on TokenRow / TokenDetailRow.
      creator: "0x000000000000000000000000000000000000beef",
      name: "filter.fun",
      seasonId: 1n,
      isProtocolLaunched: true,
    };
    const q: ApiQueries = {
      ...emptyQueries(),
      tokenByAddress: async (a) => (a === known.id ? known : null),
    };
    const r = await getTokenDetailHandler(q, known.id);
    expect(r.status).toBe(200);
  });

  it("/profile/:address returns 200 + empty for an unknown wallet (privacy exception §22)", async () => {
    // The privacy convention is intentional: not revealing whether a wallet has any
    // recorded activity. Pinned here so a future "consistency" refactor doesn't
    // accidentally flip this to 404.
    const r = await getProfileHandler(
      emptyProfileQueries(),
      "0x0000000000000000000000000000000000000099",
      () => new Date(),
    );
    expect(r.status).toBe(200);
  });
});
