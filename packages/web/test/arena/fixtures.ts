/// Fixture cohort + season for arena tests. Twelve tokens with rank 1..12,
/// HP descending — exactly the spec's "12 → 6 → 1" cohort shape.

import type {BagLock, SeasonResponse, TickerEvent, TokenResponse, TokenStatus} from "@/lib/arena/api";

const HP_BY_RANK = [98, 92, 88, 80, 72, 64, 52, 44, 32, 22, 14, 6];
const TICKERS = [
  "FILTER", "BLOOD", "KING", "SURVIVE", "MOON", "FINAL",
  "CUT", "EDGE", "SLICE", "RUG", "DUST", "GHOST",
];

function statusFor(rank: number): TokenStatus {
  if (rank <= 2) return "FINALIST";
  if (rank <= 6) return "SAFE";
  if (rank <= 9) return "AT_RISK";
  return "FILTERED";
}

function addressFor(i: number): `0x${string}` {
  return `0x${String(i + 1).padStart(40, "0")}` as `0x${string}`;
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as `0x${string}`;

/// Default bag-lock fixture — "no commitment recorded." Tests that exercise the
/// lock UI (badge presence, admin card states) override per-row.
export function makeFixtureBagLock(over: Partial<BagLock> = {}): BagLock {
  return {
    isLocked: false,
    unlockTimestamp: null,
    creator: ZERO_ADDR,
    ...over,
  };
}

export function makeFixtureCohort(): TokenResponse[] {
  return TICKERS.map((sym, i) => {
    const rank = i + 1;
    return {
      token: addressFor(i),
      ticker: `$${sym}`,
      rank,
      hp: HP_BY_RANK[i] ?? 0,
      status: statusFor(rank),
      price: "0",
      priceChange24h: 0,
      volume24h: "0",
      liquidity: "0",
      holders: 0,
      components: {
        velocity: 0.7,
        effectiveBuyers: 0.6,
        stickyLiquidity: 0.5,
        retention: 0.4,
        momentum: 0.3,
      },
      bagLock: makeFixtureBagLock(),
    } satisfies TokenResponse;
  });
}

export function makeFixtureSeason(over: Partial<SeasonResponse> = {}): SeasonResponse {
  return {
    seasonId: 2,
    phase: "competition",
    launchCount: 12,
    maxLaunches: 12,
    nextCutAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
    finalSettlementAt: new Date(Date.now() + 4 * 86400_000).toISOString(),
    championPool: "14.82",
    polReserve: "6.42",
    ...over,
  };
}

export function makeFixtureEvent(over: Partial<TickerEvent> = {}): TickerEvent {
  return {
    id: 1,
    type: "RANK_CHANGED",
    priority: "MEDIUM",
    token: "$FILTER",
    address: "0x0000000000000000000000000000000000000001",
    message: "$FILTER ↑ rank 3 → 2",
    data: {fromRank: 3, toRank: 2},
    timestamp: new Date().toISOString(),
    ...over,
  };
}
