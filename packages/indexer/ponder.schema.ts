import {onchainTable} from "@ponder/core";

/// One row per season. State machine mirror of `FilterLauncher.Phase`.
export const season = onchainTable("season", (t) => ({
  id: t.bigint().primaryKey(),
  startedAt: t.bigint().notNull(),
  vault: t.hex().notNull(),
  phase: t.text().notNull(), // "Launch" | "Filter" | "Finals" | "Settlement" | "Closed"
  winner: t.hex(),
  rolloverRoot: t.hex(),
  totalRolloverShares: t.bigint().notNull().default(0n),
  totalPot: t.bigint().notNull().default(0n),
  rolloverWinnerTokens: t.bigint().notNull().default(0n),
  bonusReserve: t.bigint().notNull().default(0n),
  finalizedAt: t.bigint(),
}));

/// One row per launched token (including $FILTER).
export const token = onchainTable("token", (t) => ({
  id: t.hex().primaryKey(), // token address
  seasonId: t.bigint().notNull(),
  symbol: t.text().notNull(),
  name: t.text().notNull(),
  metadataUri: t.text(),
  creator: t.hex().notNull(),
  locker: t.hex().notNull(),
  isProtocolLaunched: t.boolean().notNull().default(false),
  isFinalist: t.boolean().notNull().default(false),
  liquidated: t.boolean().notNull().default(false),
  liquidationProceeds: t.bigint(),
  createdAt: t.bigint().notNull(),
}));

/// Per-token, per-fee-collection event. Used by scoring (volume velocity).
///
/// Mirrors the four-way fee split emitted by `FilterLpLocker.FeesCollected`:
/// `toVault` / `toTreasury` / `toMechanics` / `toCreator`. The creator slice was
/// added when the fee model split off a creator-direct rebate; dropping it from
/// the schema understates `toVault + toTreasury + toMechanics + toCreator`-based
/// gross-fee aggregations and any future per-creator analytics.
export const feeAccrual = onchainTable("fee_accrual", (t) => ({
  id: t.text().primaryKey(), // `${tx}:${logIndex}`
  token: t.hex().notNull(),
  asset: t.hex().notNull(),
  toVault: t.bigint().notNull(),
  toTreasury: t.bigint().notNull(),
  toMechanics: t.bigint().notNull(),
  toCreator: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

/// One row per phase transition. Useful for the spectator timeline.
export const phaseChange = onchainTable("phase_change", (t) => ({
  id: t.text().primaryKey(), // `${seasonId}:${index}`
  seasonId: t.bigint().notNull(),
  newPhase: t.text().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

export const liquidation = onchainTable("liquidation", (t) => ({
  id: t.text().primaryKey(), // `${seasonId}:${token}`
  seasonId: t.bigint().notNull(),
  token: t.hex().notNull(),
  wethOut: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

export const rolloverClaim = onchainTable("rollover_claim", (t) => ({
  id: t.text().primaryKey(), // `${seasonId}:${user}`
  seasonId: t.bigint().notNull(),
  user: t.hex().notNull(),
  share: t.bigint().notNull(),
  winnerTokens: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

export const bonusFunding = onchainTable("bonus_funding", (t) => ({
  id: t.bigint().primaryKey(), // seasonId
  vault: t.hex().notNull(),
  winnerToken: t.hex().notNull(),
  reserve: t.bigint().notNull(),
  unlockTime: t.bigint().notNull(),
  rootPosted: t.boolean().notNull().default(false),
}));

export const bonusClaim = onchainTable("bonus_claim", (t) => ({
  id: t.text().primaryKey(), // `${seasonId}:${user}`
  seasonId: t.bigint().notNull(),
  user: t.hex().notNull(),
  amount: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

/// Lookup: vault address → seasonId. Populated at `SeasonStarted`. Lets vault-event handlers
/// resolve their season by primary-key fetch instead of a where-clause query.
export const vaultSeason = onchainTable("vault_season", (t) => ({
  vault: t.hex().primaryKey(),
  seasonId: t.bigint().notNull(),
}));

// ============================================================ Enrichment indexes (PR #45)
//
// Everything below this line was added by the indexer-enrichment PR to back
// /tokens/:address/history (HP timeseries), /profile.stats deferred fields
// (filtersSurvived, lifetimeTradeVolumeWei, tokensTraded), holder-derived badges
// (WEEK_WINNER, FILTER_SURVIVOR), tournament-tier badges, and the bag-lock surface
// on /tokens. See packages/indexer/README.md → "Enrichment indexes" for the wire
// shape mapping.

/// Pool-id ↔ token mapping. Populated from `FilterFactory.TokenDeployed`. Lets the
/// V4PoolManager swap handler resolve `Swap.id` (a `PoolId` = bytes32) back to the
/// token contract emitting trades on that pool. Without this, indexed swap rows
/// can't be joined onto our `token` table for /profile aggregation.
export const pool = onchainTable("pool", (t) => ({
  id: t.hex().primaryKey(), // PoolId (bytes32) — keccak256(abi.encode(PoolKey))
  token: t.hex().notNull(),
  locker: t.hex().notNull(),
  creator: t.hex().notNull(),
}));

/// One row per Uniswap V4 swap on a filter.fun pool. `side` derives from the sign
/// of `amount0` / `amount1` after token0/token1 ordering is resolved against the
/// filter token vs WETH (see `src/V4PoolManager.ts`). `wethValue` is the absolute
/// WETH delta — used to sum `lifetimeTradeVolumeWei` per wallet.
export const swap = onchainTable("swap", (t) => ({
  id: t.text().primaryKey(), // `${tx}:${logIndex}`
  poolId: t.hex().notNull(),
  token: t.hex().notNull(),
  taker: t.hex().notNull(),
  side: t.text().notNull(), // "BUY" | "SELL"
  wethValue: t.bigint().notNull(), // absolute WETH leg, wei
  tokenAmount: t.bigint().notNull(), // absolute token leg, wei
  txHash: t.hex().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

/// HP scoring snapshot — one row per (token, snapshotAt). Written by a periodic
/// block trigger so /tokens/:address/history can replay HP without recomputing
/// against historical fee rows for every request. Components are stored as the
/// 0–1 score (not yet weighted) so consumers can re-derive HP under hypothetical
/// weight changes.
export const hpSnapshot = onchainTable("hp_snapshot", (t) => ({
  id: t.text().primaryKey(), // `${token}:${snapshotAtSec}`
  token: t.hex().notNull(),
  snapshotAtSec: t.bigint().notNull(),
  hp: t.integer().notNull(), // 0..100
  rank: t.integer().notNull().default(0), // cohort rank at snapshot time, 0 = unranked
  velocity: t.real().notNull(),
  effectiveBuyers: t.real().notNull(),
  stickyLiquidity: t.real().notNull(),
  retention: t.real().notNull(),
  momentum: t.real().notNull(),
  phase: t.text().notNull(), // ApiPhase string ("launch" | "competition" | "finals" | "settled")
  blockNumber: t.bigint().notNull(),
}));

/// Running per-(token, holder) balance. Updated on every FilterToken Transfer.
/// `balance` is the wei-denominated ERC-20 balance after the transfer. We keep
/// the latest only — historical balances live in `holderSnapshot`.
///
/// Zero-balance rows are not deleted — keeping them simplifies the diff path
/// (we always have a row to update) and the holder-snapshot writer ignores
/// rows below the dust threshold anyway.
export const holderBalance = onchainTable("holder_balance", (t) => ({
  id: t.text().primaryKey(), // `${token}:${holder}`
  token: t.hex().notNull(),
  holder: t.hex().notNull(),
  balance: t.bigint().notNull().default(0n),
  blockTimestamp: t.bigint().notNull(),
}));

/// Snapshot of `holderBalance` rows above dust at a defined trigger event:
/// `CUT` (first `Liquidated` event of a season — that's our "first cut" anchor)
/// or `FINALIZE` (`SeasonVault.Finalized`). Used to compute filtersSurvived
/// (cohort overlap with surviving tokens at first cut), WEEK_WINNER badge
/// (held the winning token at finalize), and FILTER_SURVIVOR badge (held any
/// non-filtered token at first cut).
export const holderSnapshot = onchainTable("holder_snapshot", (t) => ({
  id: t.text().primaryKey(), // `${seasonId}:${trigger}:${token}:${holder}`
  seasonId: t.bigint().notNull(),
  trigger: t.text().notNull(), // "CUT" | "FINALIZE"
  token: t.hex().notNull(),
  holder: t.hex().notNull(),
  balance: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));

/// Latest `Committed` event per (creator, token) — used for the bag-lock surface
/// on /tokens. Locks monotonically increase, so we just overwrite. `previousUnlock`
/// is preserved for indexer audits ("what extension just happened").
export const creatorLock = onchainTable("creator_lock", (t) => ({
  id: t.text().primaryKey(), // `${creator}:${token}`
  creator: t.hex().notNull(),
  token: t.hex().notNull(),
  unlockTimestamp: t.bigint().notNull(),
  previousUnlock: t.bigint().notNull().default(0n),
  lastUpdatedAt: t.bigint().notNull(),
}));

/// Latest tournament status per token. Driven by `TournamentRegistry` events —
/// see `src/TournamentRegistry.ts`. Status enum mirrors the contract's
/// `TokenStatus`: ACTIVE | FILTERED | WEEKLY_WINNER | QUARTERLY_FINALIST |
/// QUARTERLY_CHAMPION | ANNUAL_FINALIST | ANNUAL_CHAMPION.
///
/// `year` and `quarter` are populated when the status reflects a tournament-tier
/// title (QUARTERLY_*, ANNUAL_*) so /profile.createdTokens[].status can label it
/// "Q1 2026 Champion" without a second lookup.
export const tournamentStatus = onchainTable("tournament_status", (t) => ({
  id: t.hex().primaryKey(), // token address
  status: t.text().notNull(),
  year: t.integer(),
  quarter: t.integer(),
  lastUpdatedAt: t.bigint().notNull(),
}));

/// Per-(year, quarter) quarterly Filter Bowl finalist memberships. One row per
/// (year, quarter, token). Used for badge derivation: a wallet that ever held
/// any QUARTERLY_FINALIST token earns the QUARTERLY_FINALIST badge.
export const tournamentQuarterEntrant = onchainTable("tournament_quarter_entrant", (t) => ({
  id: t.text().primaryKey(), // `${year}:${quarter}:${token}`
  year: t.integer().notNull(),
  quarter: t.integer().notNull(),
  token: t.hex().notNull(),
  isChampion: t.boolean().notNull().default(false),
  recordedAt: t.bigint().notNull(),
}));

/// Per-year annual finalist memberships. Mirrors `tournamentQuarterEntrant` for
/// the annual ladder. Annual is dormant per spec §33.8 (decision: do not trigger),
/// but the table + handler ship anyway so the surface works if/when activated.
export const tournamentAnnualEntrant = onchainTable("tournament_annual_entrant", (t) => ({
  id: t.text().primaryKey(), // `${year}:${token}`
  year: t.integer().notNull(),
  token: t.hex().notNull(),
  isChampion: t.boolean().notNull().default(false),
  recordedAt: t.bigint().notNull(),
}));
