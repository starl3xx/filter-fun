/// Pure handler for `GET /profile/:address`.
///
/// Per-wallet stats derived from indexed state. The data we surface today:
///
///   - **createdTokens** — every token whose `creator = address`, with the lifecycle
///     status mapped onto the spec §22.2 enum. Tokens from past seasons + the current
///     season are both included.
///   - **stats** — winnable/claimable-total subset. `wins` and `rolloverEarnedWei` and
///     `bonusEarnedWei` come straight from indexed claim events. `filtersSurvived` and
///     `lifetimeTradeVolumeWei` and `tokensTraded` are reported as `0` until the
///     supporting indexes (holder snapshots + swap events) ship — see TODO comments
///     below and the PR body for the follow-up issue.
///   - **badges** — derived from `createdTokens`. `CHAMPION_CREATOR` fires when the
///     wallet created a `WEEKLY_WINNER`. Other badges (`WEEK_WINNER`, `FILTER_SURVIVOR`,
///     tournament tier) require holder/tournament indexes and are deferred.
///
/// Unknown wallets return 200 with the all-zero shape rather than 404 — spec §22 expects
/// the Arena profile UI to render an empty state for new wallets, and 200/zero avoids
/// leaking "is this address ever been a player" via status code.

import {tickerWithDollar} from "./builders.js";

export type CreatedTokenStatus =
  | "ACTIVE"
  | "FILTERED"
  | "WEEKLY_WINNER"
  | "QUARTERLY_FINALIST"
  | "QUARTERLY_CHAMPION"
  | "ANNUAL_FINALIST"
  | "ANNUAL_CHAMPION";

export type ProfileBadge =
  | "WEEK_WINNER"
  | "FILTER_SURVIVOR"
  | "CHAMPION_CREATOR"
  | "QUARTERLY_FINALIST"
  | "QUARTERLY_CHAMPION"
  | "ANNUAL_FINALIST"
  | "ANNUAL_CHAMPION";

export interface ProfileResponse {
  address: `0x${string}`;
  createdTokens: Array<{
    token: `0x${string}`;
    ticker: string;
    seasonId: number;
    rank: number;
    status: CreatedTokenStatus;
    launchedAt: string;
  }>;
  stats: {
    wins: number;
    filtersSurvived: number;
    rolloverEarnedWei: string;
    bonusEarnedWei: string;
    lifetimeTradeVolumeWei: string;
    tokensTraded: number;
  };
  badges: ProfileBadge[];
  computedAt: string;
}

/// Row shape returned by the queries adapter for tokens created by a given wallet. The
/// `seasonWinner` carries the winning-token address from the same season, so we can map
/// `WEEKLY_WINNER` status without a separate query per token.
export interface CreatedTokenRow {
  id: `0x${string}`;
  symbol: string;
  seasonId: bigint;
  liquidated: boolean;
  isFinalist: boolean;
  createdAt: bigint;
  /// `season.winner` for the same `seasonId` — null when the season hasn't been finalized.
  seasonWinner: `0x${string}` | null;
  /// Pre-computed rank for tokens still alive in the current cohort. Null for tokens from
  /// past seasons (rank no longer meaningful) and unscored launch-phase tokens.
  rank: number | null;
}

export interface ClaimSums {
  /// Sum of `rolloverClaim.winnerTokens` across all rollover claims by this wallet. Stored
  /// as a bigint — winner-token wei units (18-decimal ERC20). Future Epic 1.10 maps these
  /// to WETH-equivalent; for now we surface the raw aggregate.
  rolloverEarnedWei: bigint;
  /// Sum of `bonusClaim.amount`. Always WEI directly (the bonus is paid in WETH).
  bonusEarnedWei: bigint;
}

export interface ProfileQueries {
  /// Tokens whose `creator` equals the lowercased address.
  createdTokensByCreator: (creator: `0x${string}`) => Promise<CreatedTokenRow[]>;
  /// Aggregate claim sums for the lowercased address.
  claimSumsForUser: (user: `0x${string}`) => Promise<ClaimSums>;
}

export async function getProfileHandler(
  q: ProfileQueries,
  rawAddress: string,
  /// Caller-injected clock so tests can pin `computedAt`. Route passes `() => new Date()`.
  now: () => Date,
): Promise<{status: number; body: ProfileResponse | {error: string}}> {
  const lower = rawAddress.toLowerCase();
  if (!isAddressLike(lower)) return {status: 400, body: {error: "invalid address"}};
  const addr = lower as `0x${string}`;

  const [created, claims] = await Promise.all([
    q.createdTokensByCreator(addr),
    q.claimSumsForUser(addr),
  ]);

  const createdTokens = created.map((r) => ({
    token: r.id,
    ticker: tickerWithDollar(r.symbol),
    seasonId: Number(r.seasonId),
    rank: r.rank ?? 0,
    status: createdTokenStatus(r),
    launchedAt: new Date(Number(r.createdAt) * 1000).toISOString(),
  }));

  const wins = createdTokens.filter((t) => t.status === "WEEKLY_WINNER").length;

  return {
    status: 200,
    body: {
      address: addr,
      createdTokens,
      stats: {
        wins,
        // TODO(Epic 1.4 follow-up): requires holder-snapshot index at first-cut time.
        // Tracked in https://github.com/starl3xx/filter-fun/issues — see PR body.
        filtersSurvived: 0,
        rolloverEarnedWei: claims.rolloverEarnedWei.toString(),
        bonusEarnedWei: claims.bonusEarnedWei.toString(),
        // TODO(Epic 1.4 follow-up): requires swap-event indexing (currently we only index
        // FeesCollected accruals, not Uniswap V4 Swap events).
        lifetimeTradeVolumeWei: "0",
        tokensTraded: 0,
      },
      badges: deriveBadges(createdTokens),
      computedAt: now().toISOString(),
    },
  };
}

function createdTokenStatus(r: CreatedTokenRow): CreatedTokenStatus {
  if (r.liquidated) return "FILTERED";
  if (r.seasonWinner && r.seasonWinner.toLowerCase() === r.id.toLowerCase()) {
    return "WEEKLY_WINNER";
  }
  // Tournament tier statuses (QUARTERLY_*, ANNUAL_*) need the championship registry index
  // (Epic 1.5). Until that ships, finalist-but-not-yet-won tokens land on ACTIVE rather
  // than guessing — surfacing a wrong tier is worse than not surfacing one yet.
  return "ACTIVE";
}

function deriveBadges(
  createdTokens: ReadonlyArray<{status: CreatedTokenStatus}>,
): ProfileBadge[] {
  const badges = new Set<ProfileBadge>();
  if (createdTokens.some((t) => t.status === "WEEKLY_WINNER")) {
    badges.add("CHAMPION_CREATOR");
  }
  // WEEK_WINNER (held a winning token), FILTER_SURVIVOR (held a survivor at first cut),
  // and the tournament tier badges all require indexes that don't exist yet. Deferred.
  return [...badges];
}

export function isAddressLike(s: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(s);
}
