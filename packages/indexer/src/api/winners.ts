/// Pure handlers for `/winners` and `/winners/:address/metrics` — Epic 1.26.
///
/// Spec §11.4 (Filter Fund Liquidity Reserve), §10.3 / §10.6 (perpetual creator
/// fees), §36.1.6 (winners are durable). The winner detail page at `/w/[address]`
/// surfaces the long tail of a winning token: Reserve growth, perpetual fee
/// accrual, holder retention, and the four-destination Filter Fund money-came-
/// from breakdown.
///
/// **Squeaker math.** A winning token with `winMarginHp = winningHp -
/// secondPlaceHp ≤ 500` (the same NEAR_MISS_THRESHOLD_HP threshold used in
/// graveyard.ts per spec §36.3.3) is `isSqueaker`. The narrative copy on the
/// winner page surfaces "Won by 2.4 HP" (margin / 100) for these tokens.

import {isAddressLike, tickerWithDollar, weiToDecimalEther} from "./builders.js";
import {NEAR_MISS_THRESHOLD_HP} from "./graveyard.js";

// ============================================================ /winners

export interface WinnerRow {
  address: `0x${string}`;
  ticker: string;
  season: number;
  /// Unix-seconds the winner was committed via `submitWinner` (spec §9.4).
  /// Null while the season is still pre-settlement (the winner row shouldn't
  /// surface in this endpoint until then; defensive null guard).
  settledAt: number | null;
  creator: `0x${string}`;
  creatorUsername: string | null;
  creatorAvatarUrl: string | null;
  /// Integer HP at FINALIZE (h168). Sourced from the FINALIZE-tagged hpSnapshot
  /// row for the winning token.
  winningHp: number;
  /// HP of the runner-up at FINALIZE — the second-place finals token. Null
  /// when the cohort had no second-place row (a single-token finale; rare).
  secondPlaceHp: number | null;
  /// `winningHp - secondPlaceHp`. Null when secondPlaceHp is null.
  winMarginHp: number | null;
  /// `winMarginHp ≤ NEAR_MISS_THRESHOLD_HP`. False when `winMarginHp` is null.
  isSqueaker: boolean;
  /// Decimal-ether of the current Filter Fund Liquidity Reserve (spec §11.4).
  /// Sourced from the post-settlement WETH inflow into the singleton reserve.
  /// `"0"` until V4 reads + reserve indexing land — see comment in winners
  /// queries adapter.
  currentReserveWeth: string;
  /// Decimal-ether of the current market cap. `"0"` until V4 reads land.
  currentMcapWeth: string;
}

export interface WinnersResponse {
  winners: WinnerRow[];
  total: number;
}

/// One source row per winning token, joined to the season + FINALIZE-tagged
/// hpSnapshot rows for the cohort.
export interface WinnerSourceRow {
  address: `0x${string}`;
  symbol: string;
  seasonId: bigint;
  creator: `0x${string}`;
  /// Block timestamp of `submitWinner` from `season.winnerSettledAt`. Null
  /// for seasons that finalized but haven't yet posted the winner (a state
  /// only reachable in mid-settlement; defensively surfaced as null).
  settledAt: bigint | null;
  /// Integer HP from the FINALIZE-tagged hpSnapshot row for the winner.
  winningHp: number;
  /// Highest HP among non-winning FINALIZE-tagged rows for the same season.
  secondPlaceHp: number | null;
  /// Spec §11.4 — Filter Fund Liquidity Reserve total, in wei. Today returns
  /// 0n (the reserve is indexed but not yet aggregated per-winner); narrows
  /// once the post-settlement POL routing is wired into the response.
  currentReserveWei: bigint;
  /// Spec §10.3 — current market cap in wei. 0n today (V4 reads pending).
  currentMcapWei: bigint;
}

export interface WinnersQueries {
  /// All winning tokens across all indexed seasons. Implementation joins
  /// `season` × `token` × `hpSnapshot[trigger=FINALIZE]`. Order is
  /// unspecified; the handler sorts by `settledAt` desc.
  winnerTokens: () => Promise<WinnerSourceRow[]>;
  /// Bulk creator-profile lookup, keyed by lowercased address.
  creatorProfilesFor: (
    addresses: ReadonlyArray<`0x${string}`>,
  ) => Promise<Map<string, {username: string | null; avatarUrl: string | null}>>;
}

export async function getWinnersHandler(
  q: WinnersQueries,
): Promise<{status: number; body: WinnersResponse}> {
  const sourceRows = await q.winnerTokens();
  const decorated: WinnerRow[] = sourceRows.map((r) => {
    // Bugbot PR #103 pass-13: defend against the indexer-lag case where the
    // winner's FINALIZE-tagged hpSnapshot row hasn't landed yet but the
    // runner-up's has. winningHp would be 0 while secondPlaceHp populates,
    // yielding negative winMarginHp — and `-N <= 500` flips isSqueaker on,
    // so the UI would render "won by -80 HP" as a squeaker callout. Mirror
    // graveyard's clamp-and-suppress: surface margin=null AND isSqueaker=
    // false when the raw computation would go negative.
    const rawMargin =
      r.secondPlaceHp === null ? null : r.winningHp - r.secondPlaceHp;
    const winMarginAnomaly = rawMargin !== null && rawMargin < 0;
    const winMarginHp = winMarginAnomaly ? null : rawMargin;
    const isSqueaker =
      !winMarginAnomaly &&
      winMarginHp !== null &&
      winMarginHp <= NEAR_MISS_THRESHOLD_HP;
    return {
      address: r.address,
      ticker: tickerWithDollar(r.symbol),
      season: Number(r.seasonId),
      settledAt: r.settledAt === null ? null : Number(r.settledAt),
      creator: r.creator,
      creatorUsername: null, // decorated below
      creatorAvatarUrl: null,
      winningHp: r.winningHp,
      secondPlaceHp: r.secondPlaceHp,
      winMarginHp,
      // Win margins above the threshold get no "squeaker" narrative — spec
      // §36.3.3 don't-change: don't manufacture drama where none exists.
      isSqueaker,
      currentReserveWeth: weiToDecimalEther(r.currentReserveWei),
      currentMcapWeth: weiToDecimalEther(r.currentMcapWei),
    };
  });

  decorated.sort((a, b) => {
    const av = a.settledAt ?? 0;
    const bv = b.settledAt ?? 0;
    if (av !== bv) return bv - av;
    return a.address.localeCompare(b.address);
  });

  // Decorate creator profile (post-sort, post-paging is irrelevant since the
  // winner count is small — one per week).
  const creatorAddrs = [...new Set(decorated.map((r) => r.creator))];
  let profileMap: Map<string, {username: string | null; avatarUrl: string | null}>;
  try {
    profileMap = await q.creatorProfilesFor(creatorAddrs);
  } catch {
    profileMap = new Map();
  }
  for (const w of decorated) {
    const p = profileMap.get(w.creator.toLowerCase());
    w.creatorUsername = p?.username ?? null;
    w.creatorAvatarUrl = p?.avatarUrl ?? null;
  }

  return {
    status: 200,
    body: {winners: decorated, total: decorated.length},
  };
}

// ============================================================ /winners/:address/metrics

export interface WinnerMetricsResponse {
  token: {
    address: `0x${string}`;
    ticker: string;
    name: string;
    creator: `0x${string}`;
    creatorUsername: string | null;
    creatorAvatarUrl: string | null;
  };
  season: number;
  settledAt: number | null;
  winningHp: number;
  secondPlaceHp: number | null;
  winMarginHp: number | null;
  isSqueaker: boolean;
  /// The runner-up token. Null when there was no second-place row (single-
  /// token finale).
  secondPlace: {
    address: `0x${string}`;
    ticker: string;
    finalHp: number;
    creator: `0x${string}`;
    creatorUsername: string | null;
  } | null;
  /// Reserve growth — one point per indexed sample. Decimal-ether values.
  reserveGrowth: Array<{timestamp: number; reserveWeth: string}>;
  /// Per-day cumulative creator-fee accrual + per-day Filter Fund Liquidity
  /// Reserve top-up. Spec §10.3 (creator) + §11.4 (POL/Reserve top-up).
  feeAccrual: Array<{
    timestamp: number;
    creatorEarnedWeth: string;
    polTopUpWeth: string;
  }>;
  /// Holder retention — one point per indexed sample. `activeHolders` is the
  /// total count; `fromOriginal` is the subset still holding from settlement
  /// (anchor at h168 per spec §36.1.6).
  holderRetention: Array<{
    timestamp: number;
    activeHolders: number;
    fromOriginal: number;
  }>;
}

export interface WinnerMetricsSourceToken {
  address: `0x${string}`;
  symbol: string;
  name: string;
  seasonId: bigint;
  creator: `0x${string}`;
  /// `season.winnerSettledAt` for the same season. Null while pre-settlement.
  settledAt: bigint | null;
  /// Integer HP at FINALIZE.
  winningHp: number;
}

export interface WinnerMetricsQueries {
  /// Token + season summary for the winner address. Returns null when the
  /// address is unknown or isn't actually the winner of any season.
  winnerSummary: (addr: `0x${string}`) => Promise<WinnerMetricsSourceToken | null>;
  /// Runner-up token info for a season.
  runnerUpForSeason: (seasonId: bigint) => Promise<{
    address: `0x${string}`;
    symbol: string;
    creator: `0x${string}`;
    finalHp: number;
  } | null>;
  /// Reserve growth series — one row per sample.
  reserveSeriesForToken: (addr: `0x${string}`) => Promise<
    Array<{timestamp: bigint; reserveWei: bigint}>
  >;
  /// Daily fee-accrual rollups for the token (creator slice + POL top-up).
  feeAccrualSeries: (addr: `0x${string}`) => Promise<
    Array<{timestamp: bigint; creatorEarnedWei: bigint; polTopUpWei: bigint}>
  >;
  /// Holder retention series since settlement.
  holderRetentionSeries: (addr: `0x${string}`) => Promise<
    Array<{timestamp: bigint; activeHolders: number; fromOriginal: number}>
  >;
  /// Single-creator profile lookup (Epic 1.24).
  creatorProfile: (
    addr: `0x${string}`,
  ) => Promise<{username: string | null; avatarUrl: string | null} | null>;
}

export async function getWinnerMetricsHandler(
  q: WinnerMetricsQueries,
  rawAddress: string,
): Promise<{status: number; body: WinnerMetricsResponse | {error: string}}> {
  const lower = rawAddress.toLowerCase();
  if (!isAddressLike(lower)) return {status: 400, body: {error: "invalid address"}};
  const addr = lower as `0x${string}`;

  const summary = await q.winnerSummary(addr);
  if (!summary) return {status: 404, body: {error: "unknown winner"}};

  const [runnerUp, reserveRows, feeRows, holderRows, creatorProfile] = await Promise.all([
    q.runnerUpForSeason(summary.seasonId),
    q.reserveSeriesForToken(addr),
    q.feeAccrualSeries(addr),
    q.holderRetentionSeries(addr),
    q.creatorProfile(summary.creator),
  ]);

  let runnerUpProfile: {username: string | null; avatarUrl: string | null} | null = null;
  if (runnerUp) {
    runnerUpProfile = await q.creatorProfile(runnerUp.creator).catch(() => null);
  }

  const winMarginHp = runnerUp ? summary.winningHp - runnerUp.finalHp : null;
  const isSqueaker =
    winMarginHp !== null && winMarginHp <= NEAR_MISS_THRESHOLD_HP;

  return {
    status: 200,
    body: {
      token: {
        address: summary.address,
        ticker: tickerWithDollar(summary.symbol),
        name: summary.name,
        creator: summary.creator,
        creatorUsername: creatorProfile?.username ?? null,
        creatorAvatarUrl: creatorProfile?.avatarUrl ?? null,
      },
      season: Number(summary.seasonId),
      settledAt: summary.settledAt === null ? null : Number(summary.settledAt),
      winningHp: summary.winningHp,
      secondPlaceHp: runnerUp?.finalHp ?? null,
      winMarginHp,
      isSqueaker,
      secondPlace: runnerUp
        ? {
            address: runnerUp.address,
            ticker: tickerWithDollar(runnerUp.symbol),
            finalHp: runnerUp.finalHp,
            creator: runnerUp.creator,
            creatorUsername: runnerUpProfile?.username ?? null,
          }
        : null,
      reserveGrowth: reserveRows.map((r) => ({
        timestamp: Number(r.timestamp),
        reserveWeth: weiToDecimalEther(r.reserveWei),
      })),
      feeAccrual: feeRows.map((r) => ({
        timestamp: Number(r.timestamp),
        creatorEarnedWeth: weiToDecimalEther(r.creatorEarnedWei),
        polTopUpWeth: weiToDecimalEther(r.polTopUpWei),
      })),
      holderRetention: holderRows.map((r) => ({
        timestamp: Number(r.timestamp),
        activeHolders: r.activeHolders,
        fromOriginal: r.fromOriginal,
      })),
    },
  };
}
