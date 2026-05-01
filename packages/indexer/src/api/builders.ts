/// Pure response builders for the `/season` and `/tokens` endpoints.
///
/// The route handlers in `./index.ts` do the Drizzle queries and pass plain rows here.
/// Keeping these functions pure (no DB / framework deps) means we can vitest them against
/// fixtures without booting Ponder, which is the testing path required by the off-chain CI
/// workflow.

import type {ScoredToken} from "@filter-fun/scoring";

import {finalSettlementAtIso, nextCutAtIso, toApiPhase, type ApiPhase} from "./phase.js";
import {statusOf, type TokenStatus} from "./status.js";

// ============================================================ /season

export interface SeasonRow {
  id: bigint;
  startedAt: bigint;
  phase: string;
  // Filter cuts deposit WETH into `season.totalPot` at finalize time. The pre-finalize sum
  // is the running tally of liquidations recorded as the season progresses.
  totalPot: bigint;
  bonusReserve: bigint;
}

export interface SeasonResponse {
  seasonId: number;
  phase: ApiPhase;
  launchCount: number;
  maxLaunches: 12;
  nextCutAt: string;
  finalSettlementAt: string;
  championPool: string;
  polReserve: string;
}

export const MAX_LAUNCHES = 12 as const;

/// Builds the `/season` response.
///
/// `launchCount` comes from a cheap `count(tokens where seasonId = id and !isProtocolLaunched)`
/// rather than a dedicated counter on `season` — the schema doesn't track it, and counting
/// 12 rows is free.
///
/// `championPool` derives from `season.totalPot - bonusReserve`. Pre-finalize this is 0 / 0;
/// post-finalize it reflects the WETH headed to the winner ecosystem (rollover + POL +
/// mechanics + treasury still folded together). When Epic 1.10 / part 2 lands and we index
/// per-slice POL accruals, the formula tightens.
///
/// `polReserve` is currently always "0" — POL slice is not yet indexed. Surfaced explicitly
/// so the UI can render the field; will track real POLManager / SeasonPOLReserve events
/// once the indexer expansion lands.
export function buildSeasonResponse(
  season: SeasonRow,
  launchCount: number,
): SeasonResponse {
  const apiPhase = toApiPhase(season.phase);
  const championPotWei = max0(season.totalPot - season.bonusReserve);
  return {
    seasonId: Number(season.id),
    phase: apiPhase,
    launchCount,
    maxLaunches: MAX_LAUNCHES,
    nextCutAt: nextCutAtIso(season.startedAt, apiPhase),
    finalSettlementAt: finalSettlementAtIso(season.startedAt),
    championPool: weiToDecimalEther(championPotWei),
    polReserve: weiToDecimalEther(0n),
  };
}

// ============================================================ /tokens

export interface TokenRow {
  id: `0x${string}`;
  symbol: string;
  isFinalist: boolean;
  liquidated: boolean;
  liquidationProceeds: bigint | null;
  /// Creator-of-record from the launch event, surfaced so /tokens can report the
  /// bag-lock owner alongside `bagLock.unlockTimestamp`. Optional on the row so
  /// existing test fixtures (which don't set it) keep compiling — the builder
  /// falls back to `0x0` and labels the lock as "unlocked / unset" in that case.
  creator?: `0x${string}`;
}

/// Per-token bag-lock surface, derived from `creator_lock` rows the indexer mirrors
/// from `CreatorCommitments.Committed` events (spec §38.5 + §38.7). `isLocked`
/// reflects "is the creator's bag locked NOW" (`unlockTimestamp > nowSec`); the raw
/// `unlockTimestamp` is surfaced even when the lock has expired so the UI can
/// render "unlocked since <date>" without an extra round-trip.
export interface BagLock {
  isLocked: boolean;
  unlockTimestamp: number | null;
  creator: `0x${string}`;
}

export interface TokenResponse {
  token: `0x${string}`;
  ticker: string;
  rank: number;
  hp: number;
  status: TokenStatus;
  price: string;
  priceChange24h: number;
  volume24h: string;
  liquidity: string;
  holders: number;
  components: {
    velocity: number;
    effectiveBuyers: number;
    stickyLiquidity: number;
    retention: number;
    momentum: number;
  };
  bagLock: BagLock;
}

/// Builds the `/tokens` response array. Sorted by ascending rank.
///
/// Fields driven directly by HP (rank, hp, components) come from the scoring package via
/// `scored`. Fields driven by trade / holder data (price, priceChange24h, volume24h,
/// liquidity, holders) are placeholders here ("0" / 0) — see the "known gap" note in `hp.ts`.
/// Fields driven by indexed lifecycle (token row + finalist flag + liquidation state) come
/// straight from the row.
///
/// Bag-lock plumbing: `bagLockByToken` is a map keyed by lowercased token address →
/// `{creator, unlockTimestamp}`. Tokens absent from the map surface as
/// `{isLocked: false, unlockTimestamp: null, creator: row.creator ?? 0x0}` — i.e.
/// "no commitment recorded." `nowSec` drives the `isLocked` flag so a freshly-expired
/// lock immediately reports as unlocked without a re-index.
export function buildTokensResponse(
  rows: ReadonlyArray<TokenRow>,
  scored: ReadonlyMap<string, ScoredToken>,
  apiPhase: ApiPhase,
  bagLockByToken: ReadonlyMap<string, {creator: `0x${string}`; unlockTimestamp: bigint}> = new Map(),
  nowSec: bigint = 0n,
): TokenResponse[] {
  const enriched: TokenResponse[] = rows.map((r) => {
    const s = scored.get(r.id.toLowerCase());
    const rank = s?.rank ?? 0;
    const status = statusOf({
      phase: apiPhase,
      rank,
      isFinalist: r.isFinalist,
      liquidated: r.liquidated,
    });
    const lock = bagLockByToken.get(r.id.toLowerCase());
    const bagLock: BagLock = lock
      ? {
          isLocked: lock.unlockTimestamp > nowSec,
          unlockTimestamp: Number(lock.unlockTimestamp),
          creator: lock.creator,
        }
      : {
          isLocked: false,
          unlockTimestamp: null,
          creator: r.creator ?? "0x0000000000000000000000000000000000000000",
        };
    return {
      token: r.id,
      ticker: tickerWithDollar(r.symbol),
      rank,
      // Spec §26.4 example shows `hp: 82` (an integer 0-100). The scoring package
      // returns 0-1; round to 0-100 here for the wire format.
      hp: hpAsInt100(s?.hp ?? 0),
      status,
      price: "0",
      priceChange24h: 0,
      volume24h: "0",
      liquidity: "0",
      holders: 0,
      components: {
        velocity: s?.components.velocity.score ?? 0,
        effectiveBuyers: s?.components.effectiveBuyers.score ?? 0,
        stickyLiquidity: s?.components.stickyLiquidity.score ?? 0,
        retention: s?.components.retention.score ?? 0,
        momentum: s?.components.momentum.score ?? 0,
      },
      bagLock,
    };
  });
  // Sort by rank ascending; tokens with rank 0 (unscored / launch phase) sort last by id.
  enriched.sort((a, b) => {
    if (a.rank === 0 && b.rank === 0) return a.token.localeCompare(b.token);
    if (a.rank === 0) return 1;
    if (b.rank === 0) return -1;
    return a.rank - b.rank;
  });
  return enriched;
}

// ============================================================ formatting helpers

/// Always-prefix `$` for the ticker — spec §26.4 example uses `$FILTER`. Symbols that
/// already start with `$` (defensive against future contract changes) pass through untouched.
/// Exported because both `/tokens` (this file) and `/token/:address` (handlers.ts) format
/// the ticker; keeping the rule in one place avoids drift when the formatting changes.
export function tickerWithDollar(symbol: string): string {
  return symbol.startsWith("$") ? symbol : `$${symbol}`;
}

/// Convert a [0, 1] HP value into the 0–100 wire format. Exported so the events tick
/// engine can use the same clamp/rounding behavior as the REST API — duplication risks
/// the two surfaces drifting on edge cases (NaN, out-of-range) that the UI assumes are
/// identical between `/tokens` and `/events`.
export function hpAsInt100(hp01: number): number {
  if (!Number.isFinite(hp01)) return 0;
  const clamped = Math.max(0, Math.min(1, hp01));
  return Math.round(clamped * 100);
}

/// Decimal-ether string from a wei `bigint`, with up to 6 decimal places of precision.
/// Matches the spec example shape ("14.82") — fewer decimals than full 18-decimal raw,
/// enough resolution for the leaderboard.
export function weiToDecimalEther(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = abs % 10n ** 18n;
  if (frac === 0n) return `${negative ? "-" : ""}${whole.toString()}`;
  // 6-decimal rounding via integer math: fracTo6 = round(frac / 1e12).
  const scale = 10n ** 12n;
  const halfScale = scale / 2n;
  let frac6 = (frac + halfScale) / scale;
  let carryWhole = whole;
  if (frac6 >= 10n ** 6n) {
    // Rounding rolled over to the next whole unit.
    carryWhole += 1n;
    frac6 = 0n;
  }
  if (frac6 === 0n) return `${negative ? "-" : ""}${carryWhole.toString()}`;
  const fracStr = frac6.toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${carryWhole.toString()}.${fracStr}`;
}

function max0(b: bigint): bigint {
  return b < 0n ? 0n : b;
}

/// Lowercased-hex address validator. Used by every route that takes an `:address`
/// param — `/token/:address` (handlers.ts) and `/profile/:address` (profile.ts + the
/// route in index.ts). Centralized so a future regex change (e.g. accepting checksum
/// addresses without lowercasing first) lands in one place.
export function isAddressLike(s: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(s);
}
