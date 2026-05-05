/// `shouldShowEmptyState` empty-state gate (PR #102 pass-19).
///
/// Bugbot L PR #102 pass-19: pass-12 fixed the indexer to OMIT the
/// `userProfile` field on identity-layer outages so clients could
/// distinguish "unknown" from "explicitly no username". The web
/// fallback at `profile.userProfile ?? {hasUsername: false}` collapsed
/// both cases — a user with a real username but no on-chain
/// participation got 404'd during a transient indexer DB blip.
/// `shouldShowEmptyState` now routes the gate based on field
/// presence: only fire on confirmed-no-username + no-participation.

import {describe, expect, it} from "vitest";

import {shouldShowEmptyState} from "@/app/p/[identifier]/emptyStateGate";
import type {ProfileResponse} from "@/lib/arena/api";

const ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;

function emptyStats(): ProfileResponse["stats"] {
  return {
    wins: 0,
    filtersSurvived: 0,
    rolloverEarnedWei: "0",
    bonusEarnedWei: "0",
    lifetimeTradeVolumeWei: "0",
    tokensTraded: 0,
  };
}

function baseProfile(overrides: Partial<ProfileResponse> = {}): ProfileResponse {
  return {
    address: ADDR,
    createdTokens: [],
    stats: emptyStats(),
    badges: [],
    computedAt: "2026-05-04T00:00:00Z",
    ...overrides,
  };
}

describe("shouldShowEmptyState (PR #102 pass-19)", () => {
  it("404 when identity layer answered, no participation, no username", () => {
    const r = shouldShowEmptyState(
      baseProfile({
        userProfile: {address: ADDR, username: null, usernameDisplay: null, hasUsername: false},
      }),
    );
    expect(r).toBe(true);
  });

  it("renders when user has a username (regardless of participation)", () => {
    const r = shouldShowEmptyState(
      baseProfile({
        userProfile: {address: ADDR, username: "starbreaker", usernameDisplay: "StarBreaker", hasUsername: true},
      }),
    );
    expect(r).toBe(false);
  });

  it("renders when user has any participation (regardless of username)", () => {
    const r = shouldShowEmptyState(
      baseProfile({
        stats: {...emptyStats(), wins: 1},
        userProfile: {address: ADDR, username: null, usernameDisplay: null, hasUsername: false},
      }),
    );
    expect(r).toBe(false);
  });

  it("renders when identity layer was unreachable (userProfile field absent), even with no participation", () => {
    // The fix: previously this case went to 404. Now we fail-open and
    // render — better to show an empty shell than 404 a real user
    // during a transient identity-layer outage.
    const r = shouldShowEmptyState(baseProfile({userProfile: undefined}));
    expect(r).toBe(false);
  });

  it("treats bigint stats fields as participation when non-zero", () => {
    const r = shouldShowEmptyState(
      baseProfile({
        stats: {...emptyStats(), rolloverEarnedWei: "1000000000000000000"},
        userProfile: {address: ADDR, username: null, usernameDisplay: null, hasUsername: false},
      }),
    );
    expect(r).toBe(false);
  });
});
