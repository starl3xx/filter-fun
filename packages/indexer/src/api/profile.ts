/// Pure handler for `GET /profile/:address`.
///
/// Per-wallet stats derived from indexed state. The data we surface today:
///
///   - **createdTokens** — every token whose `creator = address`, with the lifecycle
///     status mapped onto the spec §22.2 enum. Tokens from past seasons + the current
///     season are both included. Tournament-tier statuses (QUARTERLY_FINALIST/CHAMPION,
///     ANNUAL_FINALIST/CHAMPION) come from the `tournament_status` index populated by
///     `TournamentRegistry` events. ANNUAL_* surfaces ship even though spec §33.8 has
///     the annual settlement deferred indefinitely — empty until/unless activated.
///   - **stats** —
///       - `wins`, `rolloverEarnedWei`, `bonusEarnedWei` from indexed claim/season events
///       - `filtersSurvived` — count of seasons where this wallet held a `CUT`-trigger
///         holderSnapshot row (i.e. survived the first cut of the season).
///       - `lifetimeTradeVolumeWei`, `tokensTraded` — sum + distinct count from indexed
///         V4 swap events.
///   - **badges** — derived from the union of:
///       - `CHAMPION_CREATOR`: created any WEEKLY_WINNER token.
///       - `WEEK_WINNER`: held the winner at finalize (indexed via `holder_snapshot`
///         trigger=FINALIZE).
///       - `FILTER_SURVIVOR`: held any survivor at first cut (trigger=CUT).
///       - `QUARTERLY_FINALIST`/`QUARTERLY_CHAMPION`/`ANNUAL_FINALIST`/`ANNUAL_CHAMPION`:
///         held a token in the corresponding tournamentEntrant memberships.
///
/// Unknown wallets return 200 with the all-zero shape rather than 404 — spec §22 expects
/// the Arena profile UI to render an empty state for new wallets, and 200/zero avoids
/// leaking "is this address ever been a player" via status code.

import {isAddressLike, tickerWithDollar} from "./builders.js";

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
  /// Tournament-tier status from the `tournament_status` index. Null when the registry has
  /// no row (token never reached WEEKLY_WINNER) — handler falls through to the
  /// liquidated/season-winner ladder.
  tournamentStatus: CreatedTokenStatus | null;
}

export interface ClaimSums {
  rolloverEarnedWei: bigint;
  bonusEarnedWei: bigint;
}

export interface SwapAggregates {
  /// Sum of `swap.wethValue` for every row where `taker = wallet`.
  lifetimeTradeVolumeWei: bigint;
  /// Distinct `swap.token` count for the same wallet — "tokens traded."
  tokensTraded: number;
}

export interface HolderBadgeFlags {
  /// Wallet appears in any `holder_snapshot` row with `trigger = FINALIZE` AND
  /// `token = season.winner` for the same season — held the winner at finalize.
  weekWinner: boolean;
  /// Wallet appears in any `holder_snapshot` row with `trigger = CUT` — held some
  /// non-liquidated token at first cut. Same wallet → counts once per season for
  /// `filtersSurvived`.
  filterSurvivor: boolean;
  /// Number of distinct `seasonId`s where the wallet appears in any `trigger = CUT`
  /// holder_snapshot row.
  filtersSurvived: number;
}

export interface TournamentBadgeFlags {
  quarterlyFinalist: boolean;
  quarterlyChampion: boolean;
  annualFinalist: boolean;
  annualChampion: boolean;
}

export interface ProfileQueries {
  /// Tokens whose `creator` equals the lowercased address. Rows include tournament
  /// status from the registry index when available.
  createdTokensByCreator: (creator: `0x${string}`) => Promise<CreatedTokenRow[]>;
  /// Aggregate claim sums for the lowercased address.
  claimSumsForUser: (user: `0x${string}`) => Promise<ClaimSums>;
  /// Lifetime swap volume + distinct-tokens-traded for the wallet, derived from the
  /// `swap` index. Returns `{0n, 0}` for wallets that never traded (or for whom the
  /// router→EOA decoding lands them on a non-EOA `taker`).
  swapAggregatesForUser: (user: `0x${string}`) => Promise<SwapAggregates>;
  /// Holder-snapshot derivations (week-winner / filter-survivor / filtersSurvived).
  holderBadgeFlagsForUser: (user: `0x${string}`) => Promise<HolderBadgeFlags>;
  /// Tournament-tier badges. A wallet earns each tier via *any* token they held at the
  /// relevant snapshot — i.e. holder_snapshot × tournamentEntrant join. Empty when the
  /// wallet has no qualifying holdings.
  tournamentBadgeFlagsForUser: (user: `0x${string}`) => Promise<TournamentBadgeFlags>;
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

  const [created, claims, swapAgg, holderFlags, tournamentFlags] = await Promise.all([
    q.createdTokensByCreator(addr),
    q.claimSumsForUser(addr),
    q.swapAggregatesForUser(addr),
    q.holderBadgeFlagsForUser(addr),
    q.tournamentBadgeFlagsForUser(addr),
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
        filtersSurvived: holderFlags.filtersSurvived,
        rolloverEarnedWei: claims.rolloverEarnedWei.toString(),
        bonusEarnedWei: claims.bonusEarnedWei.toString(),
        lifetimeTradeVolumeWei: swapAgg.lifetimeTradeVolumeWei.toString(),
        tokensTraded: swapAgg.tokensTraded,
      },
      badges: deriveBadges(createdTokens, holderFlags, tournamentFlags),
      computedAt: now().toISOString(),
    },
  };
}

function createdTokenStatus(r: CreatedTokenRow): CreatedTokenStatus {
  if (r.liquidated) return "FILTERED";
  // Tournament tier outranks the WEEKLY_WINNER fallback — once a token has won a
  // quarterly Filter Bowl or annual championship, the registry row promotes its
  // status above the season-level winner label.
  if (r.tournamentStatus && r.tournamentStatus !== "ACTIVE") {
    // Defensive: don't surface `FILTERED` from the registry if our local `liquidated`
    // flag disagrees — covered above. WEEKLY_WINNER from the registry equates to the
    // legacy season-winner check; either path is correct.
    return r.tournamentStatus;
  }
  if (r.seasonWinner && r.seasonWinner.toLowerCase() === r.id.toLowerCase()) {
    return "WEEKLY_WINNER";
  }
  return "ACTIVE";
}

function deriveBadges(
  createdTokens: ReadonlyArray<{status: CreatedTokenStatus}>,
  holder: HolderBadgeFlags,
  tourney: TournamentBadgeFlags,
): ProfileBadge[] {
  const badges = new Set<ProfileBadge>();
  if (createdTokens.some((t) => t.status === "WEEKLY_WINNER")) {
    badges.add("CHAMPION_CREATOR");
  }
  if (holder.weekWinner) badges.add("WEEK_WINNER");
  if (holder.filterSurvivor) badges.add("FILTER_SURVIVOR");
  if (tourney.quarterlyFinalist) badges.add("QUARTERLY_FINALIST");
  if (tourney.quarterlyChampion) badges.add("QUARTERLY_CHAMPION");
  if (tourney.annualFinalist) badges.add("ANNUAL_FINALIST");
  if (tourney.annualChampion) badges.add("ANNUAL_CHAMPION");
  return [...badges];
}
