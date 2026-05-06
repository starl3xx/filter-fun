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
  /// Epic 1.16 (spec §9.4): Unix-seconds the winner was committed via `submitWinner`. Null
  /// while the season is still active. Surfaced so the web app can resolve "is the winner
  /// pool routing fees to POL now?" in a single read against `/season` instead of poking
  /// the locker directly.
  winnerSettledAt: bigint | null;
  /// Winning token address committed via `submitWinner`, or null while the season is
  /// still active. Bugbot PR #103 pass-4: lifted onto the SeasonRow abstraction so any
  /// caller of `buildSeasonByIdLookup` (or future seasonRow consumers) reads a single
  /// shape. `marginInputsForSeason` already does its own season query for the same
  /// field; the row-level field keeps that path future-proof if it migrates to the
  /// shared lookup.
  winner: `0x${string}` | null;
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
  /// Epic 1.16: see `SeasonRow.winnerSettledAt`. Number (Unix-seconds) post-settlement;
  /// `null` while the season is still active. Frontend gates the "POL slice" copy on
  /// `winnerSettledAt != null`.
  winnerSettledAt: number | null;
  /// Epic 1.25/1.27 (spec §36.3.3) — integer HP of the lowest token that survived the
  /// CUT trigger (the "cut line"). Null pre-CUT. Powers the graveyard's near-miss
  /// margin computation and the finals-week runner-up callouts.
  cutLineHp: number | null;
  /// Epic 1.26 (spec §10.3) — integer HP of the winning token at FINALIZE. Null
  /// pre-FINALIZE.
  winningHp: number | null;
  /// Epic 1.26 (spec §36.3.3) — integer HP of the second-place finals token at
  /// FINALIZE. Null pre-FINALIZE or when the cohort had no second-place row
  /// (single-token finale).
  secondPlaceHp: number | null;
  /// `winningHp - secondPlaceHp`. Null when either operand is null. Drives the
  /// "won by 2.4 HP" squeaker callout on `/w/[address]`.
  winMarginHp: number | null;
  /// Winning token address committed via `submitWinner`, mirrored from the
  /// underlying `season.winner` row. Null while the season is still active.
  /// Surfaced so `/w/<season-id>` can resolve identifier→winner without a
  /// second `/winners` round trip (bugbot PR #103 pass-16 follow-up).
  winner: `0x${string}` | null;
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
///
/// Margin fields (Epic 1.25/1.26/1.27, spec §36.3.3) flow in from the route adapter as
/// pre-computed integers (cut line / winning HP / second-place HP). Pre-CUT they're null;
/// post-CUT `cutLineHp` populates; post-FINALIZE `winningHp` + `secondPlaceHp` +
/// `winMarginHp` populate. Backwards-compatible (additive); existing consumers ignore
/// the new fields.
export function buildSeasonResponse(
  season: SeasonRow,
  launchCount: number,
  margins: SeasonMargins = {cutLineHp: null, winningHp: null, secondPlaceHp: null},
): SeasonResponse {
  const apiPhase = toApiPhase(season.phase);
  const championPotWei = max0(season.totalPot - season.bonusReserve);
  const rawMargin =
    margins.winningHp !== null && margins.secondPlaceHp !== null
      ? margins.winningHp - margins.secondPlaceHp
      : null;
  const winMarginHp = rawMargin !== null && rawMargin < 0 ? null : rawMargin;
  return {
    seasonId: Number(season.id),
    phase: apiPhase,
    launchCount,
    maxLaunches: MAX_LAUNCHES,
    nextCutAt: nextCutAtIso(season.startedAt, apiPhase),
    finalSettlementAt: finalSettlementAtIso(season.startedAt),
    championPool: weiToDecimalEther(championPotWei),
    polReserve: weiToDecimalEther(0n),
    winnerSettledAt: season.winnerSettledAt === null ? null : Number(season.winnerSettledAt),
    cutLineHp: margins.cutLineHp,
    winningHp: margins.winningHp,
    secondPlaceHp: margins.secondPlaceHp,
    winMarginHp,
    winner: season.winner,
  };
}

/// Margin inputs for `buildSeasonResponse` (Epic 1.25/1.26/1.27).
export interface SeasonMargins {
  cutLineHp: number | null;
  winningHp: number | null;
  secondPlaceHp: number | null;
}

// ============================================================ /tokens

export interface TokenRow {
  id: `0x${string}`;
  symbol: string;
  isFinalist: boolean;
  liquidated: boolean;
  liquidationProceeds: bigint | null;
  /// Creator-of-record from the launch event, surfaced so /tokens can report the
  /// bag-lock owner alongside `bagLock.unlockTimestamp`.
  ///
  /// Audit M-Indexer-1 (Phase 1, 2026-05-01): pre-fix this was optional and the
  /// builder substituted `0x0000…` for missing values, which surfaced to the UI as
  /// "lock owner: 0x0" — silent data loss masked as a real address. Drizzle schema
  /// requires creator on the row anyway (the `tokens` table column is NOT NULL),
  /// so the optional declaration was lying. Marking required moves the contract to
  /// the type system: callers that supply incomplete rows (e.g., a future query
  /// path that joins partial data) fail at compile time, not silently in the UI.
  creator: `0x${string}`;
  /// Unix-seconds the token was deployed (`token.createdAt`). Drives the
  /// Epic 1.18 tie-break: when two tokens land on the same integer HP, the
  /// earlier-launched one ranks higher. Required since 1.18 — every cohort
  /// row carries it from the underlying `token` table.
  createdAt: bigint;
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

/// Per-row data-availability flags. Audit H-1 (Phase 1, 2026-05-01) landed these so the
/// web app can distinguish "value is genuinely zero" from "indexer hasn't wired this read
/// yet" — pre-fix, both states surfaced identically as `0` / `"0"` and the leaderboard
/// rendered "0 holders / $0 liquidity" for every row across genesis.
///
/// `v4Reads = false` until the V4 PoolManager integration epic lands; `holderEnumeration =
/// false` until the deferred `/tokens/:address/holders` endpoint ships (audit C-4 deferred
/// to Phase 2). When either flips to `true` the corresponding TokenResponse fields
/// (`price`/`priceChange24h`/`volume24h`/`liquidity` for v4Reads; `holders` for
/// holderEnumeration) become non-null.
export interface TokenDataAvailability {
  v4Reads: boolean;
  holderEnumeration: boolean;
}

export interface TokenResponse {
  token: `0x${string}`;
  ticker: string;
  rank: number;
  hp: number;
  status: TokenStatus;
  /// Audit H-1: `null` when `dataAvailability.v4Reads === false` (V4 read integration
  /// pending). Web renders "—" in that state. Will become a decimal-ether string once
  /// V4 reads land.
  price: string | null;
  /// Audit H-1: `null` when `dataAvailability.v4Reads === false`.
  priceChange24h: number | null;
  /// Audit H-1: `null` when `dataAvailability.v4Reads === false`.
  volume24h: string | null;
  /// Audit H-1: `null` when `dataAvailability.v4Reads === false`.
  liquidity: string | null;
  /// Audit H-1: `null` when `dataAvailability.holderEnumeration === false`. Holder
  /// snapshots are indexed but the public endpoint is deferred (audit C-4); both fields
  /// flip together when that endpoint ships.
  holders: number | null;
  /// Epic 1.28 — fixed total supply for the token, expressed as a decimal-ether
  /// string. Every FilterToken mints `FIXED_TOKEN_SUPPLY` (1e9) at construction
  /// per `FilterFactory.DEFAULT_INITIAL_SUPPLY`; future contract changes that
  /// vary supply per-token would surface here as the per-row value rather than
  /// the cohort-wide constant. Decoupling supply from the constant lets the
  /// market-cap calculation stay correct if the launch contract ever ships a
  /// per-creator supply override.
  totalSupply: string;
  /// Epic 1.28 — `price × totalSupply` resolved server-side, in ETH (decimal-
  /// ether). `null` when `price` is `null` (v4Reads gate). Web renders "—" in
  /// that case; when v4Reads flips on the column auto-populates without a web
  /// follow-up. Pure-ETH framing intentional: the V1 cost/ROI calculator
  /// (spec §45 implementation notes) uses a hardcoded $3,500/ETH fallback;
  /// market cap mirrors that pattern (USD conversion lives downstream).
  marketCap: string | null;
  components: {
    velocity: number;
    effectiveBuyers: number;
    stickyLiquidity: number;
    retention: number;
    momentum: number;
  };
  bagLock: BagLock;
  /// Audit H-1: per-row availability map for the placeholder fields. Web should read
  /// this before rendering price/volume/liquidity/holders cells.
  dataAvailability: TokenDataAvailability;
}

/// Fixed token supply — every FilterToken mints 1e9 at construction
/// (`packages/contracts/src/FilterFactory.sol#DEFAULT_INITIAL_SUPPLY`). Used by
/// the indexer to resolve per-row `totalSupply` + `marketCap` until per-token
/// supply tracking lands. Mirrored on the web side
/// (`packages/web/src/components/arena/ArenaTile.tsx`) for the historic
/// client-side market-cap derivation; the wire field is now the source of
/// truth and the web tile reads `marketCap` directly from `TokenResponse`.
export const FIXED_TOKEN_SUPPLY_WHOLE = 1_000_000_000n;

/// Audit H-1 (Phase 1, 2026-05-01): centralised data-availability flags for placeholder
/// fields. Today both flags are hard-coded `false` because neither integration has
/// shipped — flipping a flag here without first wiring the underlying read would lie to
/// the frontend, so guard the toggle with the corresponding integration commit.
///
/// When V4 reads land: flip `v4Reads` and start populating
/// `price`/`priceChange24h`/`volume24h`/`liquidity` from the real source.
/// When `/tokens/:address/holders` lands: flip `holderEnumeration` and populate
/// `holders` from the indexed snapshot.
export const TOKEN_DATA_AVAILABILITY: TokenDataAvailability = {
  v4Reads: false,
  holderEnumeration: false,
};

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
///
/// `bagLockByToken` and `nowSec` are required (no defaults). Bugbot caught a
/// dangerous prior default of `nowSec = 0n`: any caller that supplied lock data
/// but forgot the clock would evaluate `unlockTimestamp > 0n` as `true` for every
/// row and silently report all locks as active regardless of actual expiry.
/// Callers without lock data should pass an empty map + `0n`; callers with lock
/// data must pass the real wall clock.
export function buildTokensResponse(
  rows: ReadonlyArray<TokenRow>,
  scored: ReadonlyMap<string, ScoredToken>,
  apiPhase: ApiPhase,
  bagLockByToken: ReadonlyMap<string, {creator: `0x${string}`; unlockTimestamp: bigint}>,
  nowSec: bigint,
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
          // Audit L-Indexer-3 (Phase 1, 2026-05-01): `unlockTimestamp > nowSec` above
          // assumes `unlockTimestamp` is a positive Unix-seconds bigint. The schema
          // mirrors `CreatorCommitments.Committed`'s `uint64 unlockTimestamp` (always
          // > 0 by contract — `commit(0)` reverts), so a 0 / negative value would
          // require a contract bug or a row a future query path inserts manually.
          // The comparison stays correct in either case; we just don't degrade
          // gracefully into "permanently unlocked" if the source ever drifts.
          isLocked: false,
          unlockTimestamp: null,
          creator: r.creator,
        };
    return {
      token: r.id,
      ticker: tickerWithDollar(r.symbol),
      rank,
      // Spec §6.5 + §26.4 — Epic 1.18 composite scale: integer in [0, 10000].
      // Scoring already returns the integer; the wire format passes it through.
      hp: s?.hp ?? 0,
      status,
      // Audit H-1: emit null (not "0"/0) while v4Reads + holderEnumeration are pending.
      // The web app distinguishes "—" (null, value unknown) from "0" (value confirmed
      // zero) when rendering these cells. dataAvailability below tells the renderer
      // which state applies cohort-wide.
      price: TOKEN_DATA_AVAILABILITY.v4Reads ? "0" : null,
      priceChange24h: TOKEN_DATA_AVAILABILITY.v4Reads ? 0 : null,
      volume24h: TOKEN_DATA_AVAILABILITY.v4Reads ? "0" : null,
      liquidity: TOKEN_DATA_AVAILABILITY.v4Reads ? "0" : null,
      holders: TOKEN_DATA_AVAILABILITY.holderEnumeration ? 0 : null,
      // Epic 1.28 — supply is fixed at construction; surface it now so the
      // leaderboard's Mkt cap column has a deterministic source. `marketCap`
      // derives from `price × totalSupply` server-side; null until v4Reads
      // flips on (so the web column shows "—" without a follow-up).
      totalSupply: FIXED_TOKEN_SUPPLY_WHOLE.toString(),
      marketCap: deriveMarketCap(
        TOKEN_DATA_AVAILABILITY.v4Reads ? "0" : null,
        FIXED_TOKEN_SUPPLY_WHOLE,
      ),
      components: {
        velocity: s?.components.velocity.score ?? 0,
        effectiveBuyers: s?.components.effectiveBuyers.score ?? 0,
        stickyLiquidity: s?.components.stickyLiquidity.score ?? 0,
        retention: s?.components.retention.score ?? 0,
        momentum: s?.components.momentum.score ?? 0,
      },
      bagLock,
      dataAvailability: TOKEN_DATA_AVAILABILITY,
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

/// Epic 1.28 — derives `marketCap` (decimal-ether string) from `price`
/// (decimal-ether-per-token string) × `totalSupply` (whole-token bigint).
/// Returns `null` whenever `price` is null (v4Reads gate) so the wire
/// shape stays "value unknown" for the rendering side.
///
/// Implementation. `price` arrives as a decimal-ether string (e.g.
/// "0.000000123"). To stay in integer math we parse it to wei, multiply
/// by `totalSupply`, then re-format. The result is a wei-scaled product
/// of price (ether-per-token) × supply (tokens) which simplifies to ether,
/// so we render via `weiToDecimalEther` directly.
export function deriveMarketCap(price: string | null, totalSupply: bigint): string | null {
  if (price === null) return null;
  const priceWei = parseDecimalEtherToWei(price);
  if (priceWei === null) return null;
  // priceWei (wei-per-token) × totalSupply (tokens) = wei (the product is
  // already in wei because price was per-1-token). weiToDecimalEther
  // produces the canonical decimal-ether string.
  const capWei = priceWei * totalSupply;
  return weiToDecimalEther(capWei);
}

/// Parses a decimal-ether string ("0.000000123") to wei. Returns null on
/// non-finite or otherwise malformed input. Mirror of `weiToDecimalEther`
/// going the other direction; kept local to the indexer surface because
/// market-cap derivation is the only on-server consumer today.
function parseDecimalEtherToWei(s: string): bigint | null {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  if (trimmed === "" || trimmed === "-") return null;
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  if (!/^\d+(\.\d+)?$/.test(body)) return null;
  const [whole = "0", frac = ""] = body.split(".");
  if (frac.length > 18) return null; // overflow guard — wei has 18 decimals max.
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  const wei = BigInt(whole) * 10n ** 18n + BigInt(fracPadded || "0");
  return negative ? -wei : wei;
}

/// Lowercased-hex address validator. Used by every route that takes an `:address`
/// param — `/token/:address` (handlers.ts) and `/profile/:address` (profile.ts + the
/// route in index.ts). Centralized so a future regex change (e.g. accepting checksum
/// addresses without lowercasing first) lands in one place.
export function isAddressLike(s: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(s);
}
