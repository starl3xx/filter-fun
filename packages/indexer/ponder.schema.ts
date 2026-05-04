import {onchainTable} from "@ponder/core";

/// One row per season. State machine mirror of `FilterLauncher.Phase`.
///
/// `winnerSettledAt` (Epic 1.16, spec §9.4): block timestamp at which the winner was
/// committed via `SeasonVault.submitWinner`. Zero/null while the season is still active.
/// Surfaced on `/season` so the frontend can resolve "is post-settlement fee routing in
/// effect?" in a single read; mirrors the on-chain `SeasonVault.winnerSettledAt` field.
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
  winnerSettledAt: t.bigint(),
}));

/// Per-token creator-fee accrual rollup (Epic 1.16, spec §10.3 + §10.6). One row per token.
/// Mirrors the on-chain `CreatorFeeDistributor` accounting so `/tokens/:address/creator-
/// earnings` can answer in O(1) without summing every `feeAccrual.toCreator` event in the
/// request path. Per spec §10.3 + §10.6 accrual is perpetual — the row keeps growing for
/// the life of the pool. `claimable = lifetimeAccrued - claimed`.
export const creatorEarning = onchainTable("creator_earning", (t) => ({
  token: t.hex().primaryKey(),
  seasonId: t.bigint().notNull(),
  creator: t.hex().notNull(),
  /// Wei accrued to the creator over the token's full life (Accrued events).
  lifetimeAccrued: t.bigint().notNull().default(0n),
  /// Wei the creator (or admin-redirected recipient) has pulled via `claim` events.
  claimed: t.bigint().notNull().default(0n),
  /// Wei that arrived at the distributor while emergency-disabled and routed to treasury
  /// instead of the creator. Surfaced for transparency; does NOT count toward
  /// `lifetimeAccrued`.
  redirectedToTreasury: t.bigint().notNull().default(0n),
  /// Block timestamp of the most recent successful claim (zero/null until first claim).
  lastClaimAt: t.bigint(),
  /// True after the multisig has invoked `disableCreatorFee` (sanctioned/compromised
  /// recipient). Future fees redirect to treasury (CreatorFeeRedirected events keep
  /// landing) until the row is reset by upgrade.
  disabled: t.boolean().notNull().default(false),
  /// `HP_WEIGHTS_VERSION` snapshot at row creation. Surfaced on the response so consumers
  /// can correlate earnings against the active scoring regime — useful for the cost/ROI
  /// calculator (Epic 2.10).
  weightsVersion: t.text().notNull().default("2026-05-04-v4-locked-int10k-formulas"),
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
  /// Pre-settlement (`PRE_SETTLEMENT`, spec §9.2): WETH lands at the SeasonVault.
  /// Post-settlement (`POST_SETTLEMENT`, spec §9.4 — Epic 1.16): WETH lands at the
  /// singleton POLVault instead. Same wei amount in either case; the discriminator is
  /// what makes downstream attribution (POL exposure vs prize-pool growth) honest.
  routing: t.text().notNull().default("PRE_SETTLEMENT"),
  /// Wei routed to "the prize-slice destination" — SeasonVault when
  /// `routing == "PRE_SETTLEMENT"`, POLVault when `routing == "POST_SETTLEMENT"`.
  /// Field name preserved for backwards-compat with pre-Epic-1.16 consumers; downstream
  /// readers should switch on `routing` to attribute correctly.
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
///
/// **Provenance columns (Epic 1.17a, 2026-05-03 v4 lock).** `weightsVersion`
/// stamps the active `HP_WEIGHTS_VERSION` so a row can always be tied to the
/// exact weight set that produced its `hp` value. `flagsActive` stores the
/// momentum + concentration flag state at compute time as JSON
/// (`{"momentum":bool,"concentration":bool}`); historical replays consult it
/// to reproduce the gating context.
///
/// **Epic 1.18 (2026-05-05) migration.** The HP composite scale flipped from
/// float [0, 100] to integer [0, 10000]. Existing testnet (Sepolia) rows
/// were dropped — see `scripts/migrate-int10k.sql` — so every row from the
/// cutover forward carries `weightsVersion = "2026-05-04-v4-locked-int10k-formulas"`.
/// The column type was already `integer()`; only the value range and the
/// version stamp moved. Mainnet ships clean from this version.
///
/// Pre-Epic-1.17a rows would have backfilled `weightsVersion = "pre-lock"`
/// (rows that pre-date the lock can't be retroactively assigned a real
/// version) and `flagsActive = '{"momentum":true,"concentration":false}'`
/// (the legacy 5-component v3 state — momentum on, concentration not yet
/// wired). After the 1.18 cutover those defaults are unreachable in
/// practice; the indexer writer always stamps the live values from the
/// scoring package.
export const hpSnapshot = onchainTable("hp_snapshot", (t) => ({
  id: t.text().primaryKey(), // `${token}:${snapshotAtSec}`
  token: t.hex().notNull(),
  snapshotAtSec: t.bigint().notNull(),
  // Integer in [HP_MIN, HP_MAX] = [0, 10000]. Spec §6.5 composite scale
  // (Epic 1.18 — bumped from the prior 0..100 wire format to align with
  // the BPS convention used elsewhere). Migration: existing Sepolia rows
  // were dropped pre-mainnet; mainnet ships clean from int10k. The column
  // type itself is unchanged (already `integer()`), only the value range
  // and `weightsVersion` constant moved.
  hp: t.integer().notNull(),
  rank: t.integer().notNull().default(0), // cohort rank at snapshot time, 0 = unranked
  velocity: t.real().notNull(),
  effectiveBuyers: t.real().notNull(),
  stickyLiquidity: t.real().notNull(),
  retention: t.real().notNull(),
  momentum: t.real().notNull(),
  phase: t.text().notNull(), // ApiPhase string ("launch" | "competition" | "finals" | "settled")
  blockNumber: t.bigint().notNull(),
  /// `HP_WEIGHTS_VERSION` value as of the snapshot. Indexed: history replays
  /// filter on it ("show me only post-v4-lock rows") and operator dashboards
  /// alarm if writes start landing under an unexpected version. Default
  /// reflects the int10k cutover (Epic 1.18) — historical Sepolia rows were
  /// dropped, so any new write lands under the active version.
  weightsVersion: t.text().notNull().default("2026-05-04-v4-locked-int10k-formulas"),
  /// JSON: `{"momentum":bool,"concentration":bool}`. Stored as text (not jsonb)
  /// so it round-trips cleanly through Ponder's onchainTable shapes; consumers
  /// JSON.parse on read.
  flagsActive: t.text().notNull().default('{"momentum":true,"concentration":false}'),
  /// What caused this row to be written (Epic 1.17b — compute pathway). One of:
  ///   - `BLOCK_TICK`        — periodic block-interval handler (legacy default)
  ///   - `SWAP`              — V4 PoolManager Swap event
  ///   - `HOLDER_SNAPSHOT`   — FilterToken Transfer (holder-balance change → HHI shift)
  ///   - `PHASE_BOUNDARY`    — scheduler tick at h0/24/48/72/96/168
  ///   - `CUT`               — scheduler at h96 ± 10s, settlement-authoritative
  ///   - `FINALIZE`          — scheduler at h168, winner-declaration data
  ///
  /// Settlement provenance: rows tagged `CUT` or `FINALIZE` are the inputs the
  /// oracle Merkle-publishes BEFORE calling `SeasonVault.cut()` /
  /// `.submitWinner()`. The on-chain settlement reads the oracle-posted root,
  /// not the indexed row directly — this column lets auditors trace
  /// "which scoring snapshot drove this settlement" without joining txs.
  /// Pre-Epic-1.17b rows backfill to `BLOCK_TICK` (the only writer that existed).
  trigger: t.text().notNull().default("BLOCK_TICK"),
  /// Reorg-safety status (Epic 1.22 / spec §6.12). One of:
  ///   - `tip`   — written at the head of the chain, may still reorg
  ///   - `soft`  — ≥6 blocks past write, statistically safe but not guaranteed
  ///   - `final` — ≥12 blocks past write, considered final under Base finality
  ///
  /// **Settlement contract.** Rows tagged `CUT` or `FINALIZE` MUST be `final`
  /// before the oracle's Merkle publish reads them. The publication path
  /// asserts `finality = 'final'` and refuses to post otherwise; a reorg
  /// inside the settlement window forces a re-compute.
  ///
  /// Indexer writer logic (Epic 1.22b — PR 2 will add the periodic advancer):
  ///   - SWAP / HOLDER_SNAPSHOT / BLOCK_TICK rows write as `tip`; a
  ///     periodic job advances them to `soft` at +6 blocks and `final` at +12.
  ///   - CUT / FINALIZE rows are queued and only inserted once the source
  ///     block is ≥12 confirmations past the wall-clock boundary (a row
  ///     written for a CUT trigger MUST therefore land as `final` by
  ///     construction).
  ///
  /// Pre-Epic-1.22 rows have no finality concept; default = `tip` so the
  /// schema migration is non-destructive but the legacy rows aren't usable
  /// for settlement attestation.
  finality: t.text().notNull().default("tip"),
}));

/// Running per-(token, holder) balance. Updated on every FilterToken Transfer.
/// `balance` is the wei-denominated ERC-20 balance after the transfer. We keep
/// the latest only — historical balances live in `holderSnapshot`.
///
/// Zero-balance rows are not deleted — keeping them simplifies the diff path
/// (we always have a row to update) and the holder-snapshot writer ignores
/// rows below the dust threshold anyway.
///
/// `firstSeenAt` (Epic 1.22b) — block timestamp of the first credit that took
/// this wallet from zero to positive balance. Set once on insert and not
/// updated afterwards (a wallet that exits to zero and re-enters keeps its
/// original timestamp; downstream retention treats them as long-term holders
/// who briefly dipped — the slight over-count is preferred to under-counting
/// real long-term participants who briefly exited). Used by the scoring
/// projection's retention component to approximate `holdersAtRetentionAnchor`
/// = `{w : firstSeenAt(w) ≤ now − 24h}` without a transfer-event log.
export const holderBalance = onchainTable("holder_balance", (t) => ({
  id: t.text().primaryKey(), // `${token}:${holder}`
  token: t.hex().notNull(),
  holder: t.hex().notNull(),
  balance: t.bigint().notNull().default(0n),
  blockTimestamp: t.bigint().notNull(),
  firstSeenAt: t.bigint().notNull().default(0n),
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

// ============================================================ Reservation lifecycle (Epic 1.15a)
//
// Deferred-activation launch model: creators reserve a slot via `LaunchEscrow.reserve`
// (paying creation cost into escrow, locking ticker in `seasonTickers`). The launcher
// activates a season once `ACTIVATION_THRESHOLD` slots fill — only then does the
// reservation normalize into a launched token. If the season aborts (insufficient
// reservations, oracle abort), escrow refunds the cost to creators; failed pushes go
// to `pendingRefund` for explicit-claim by the creator.
//
// Surface contract: the Arena UI uses `reservation` to render the live slot grid
// + per-creator "claim refund" CTA, and `launchEscrowSummary` for the season-level
// totals. `tickerBlocklist` and `winnerTickerReservation` back the launch-form
// pre-flight ticker-availability check.

/// One row per (seasonId, creator) reservation. The `status` column drives the
/// Arena UI's slot-grid badge ("RESERVED" → "LAUNCHED" / "REFUNDED" / "AWAITING CLAIM").
///
/// Status transitions (reservation):
///   PENDING — creator escrowed, slot held, season not activated yet
///     → RELEASED         (`launchProtocolToken` settled the slot — token deployed)
///     → REFUNDED         (`abortSeason` push refund succeeded — eth back in creator wallet)
///     → REFUND_PENDING   (`abortSeason` push refund failed — `pendingRefund` row exists)
///   REFUND_PENDING
///     → REFUND_CLAIMED   (creator called `claimPendingRefund`)
///   RELEASED
///     → FORFEITED        (post-activation, slot did not normalize — `StakeForfeited`)
///     → REFUNDED         (post-activation, slot normalized + soft-filtered — `StakeRefunded`)
///
/// `reservedAt` is the block timestamp of `SlotReserved`; `resolvedAt` is the
/// timestamp of the most recent state-changing event (release / refund / claim /
/// forfeit). Same-tx writes for ordering: a reservation that lands and immediately
/// resolves in the same block keeps both timestamps equal.
export const reservation = onchainTable("reservation", (t) => ({
  id: t.text().primaryKey(), // `${seasonId}:${creator}`
  seasonId: t.bigint().notNull(),
  creator: t.hex().notNull(),
  slotIndex: t.bigint().notNull(),
  tickerHash: t.hex().notNull(),
  metadataHash: t.hex().notNull(),
  /// Escrow amount at reservation time (in wei). The creation cost paid into
  /// `LaunchEscrow`. Refund amount on abort = this; on a refund-after-soft-filter
  /// the `StakeRefunded.amount` may differ (partial), tracked in events not here.
  escrowAmount: t.bigint().notNull(),
  /// PENDING | RELEASED | REFUNDED | REFUND_PENDING | REFUND_CLAIMED | FORFEITED
  status: t.text().notNull().default("PENDING"),
  reservedAt: t.bigint().notNull(),
  resolvedAt: t.bigint(),
  /// Token address once `RELEASED` (the launched FilterToken). Null until release.
  /// Lets the Arena UI link from the slot card to the token's leaderboard entry
  /// without joining `token` on `(seasonId, creator)`.
  token: t.hex(),
}));

/// One row per (seasonId, creator) where a refund push failed. Mirrors
/// `LaunchEscrow.pendingRefunds[seasonId][creator]` exactly so the UI can render
/// "Claim refund" without a contract read. Cleared on `PendingRefundClaimed`.
export const pendingRefund = onchainTable("pending_refund", (t) => ({
  id: t.text().primaryKey(), // `${seasonId}:${creator}`
  seasonId: t.bigint().notNull(),
  creator: t.hex().notNull(),
  amount: t.bigint().notNull(),
  /// Block timestamp of the originating `RefundFailed`. Lets the UI sort the
  /// "Claim" surface by oldest pending first.
  failedAt: t.bigint().notNull(),
  /// True once `PendingRefundClaimed` has fired — keeps a historical row for
  /// audits without violating the (seasonId, creator) primary-key uniqueness.
  /// The active-claim filter on the API is `claimed = false`.
  claimed: t.boolean().notNull().default(false),
  claimedAt: t.bigint(),
}));

/// Per-season escrow aggregates. Updated incrementally on every reservation /
/// release / refund / claim. Lets `/season/:id/launch-status` answer
/// "how many slots filled, how much eth held, how much refunded" without
/// scanning every reservation row.
export const launchEscrowSummary = onchainTable("launch_escrow_summary", (t) => ({
  id: t.bigint().primaryKey(), // seasonId
  reservationCount: t.integer().notNull().default(0),
  totalEscrowed: t.bigint().notNull().default(0n),
  totalReleased: t.bigint().notNull().default(0n),
  totalRefunded: t.bigint().notNull().default(0n),
  totalRefundPending: t.bigint().notNull().default(0n),
  totalForfeited: t.bigint().notNull().default(0n),
  /// True once the launcher activated this season (≥ACTIVATION_THRESHOLD slots filled).
  activated: t.boolean().notNull().default(false),
  activatedAt: t.bigint(),
  /// True once the launcher aborted this season. Mutually exclusive with `activated`.
  aborted: t.boolean().notNull().default(false),
  abortedAt: t.bigint(),
}));

/// Per-season ticker reservations — one row per (seasonId, tickerHash). Mirrors
/// `FilterLauncher.seasonTickers[seasonId][hash]`. Used by the launch-form
/// pre-flight check `/season/:id/tickers/check?ticker=PEPE`. Cleared on abort.
export const seasonTickerReservation = onchainTable("season_ticker_reservation", (t) => ({
  id: t.text().primaryKey(), // `${seasonId}:${tickerHash}`
  seasonId: t.bigint().notNull(),
  tickerHash: t.hex().notNull(),
  creator: t.hex().notNull(),
  reservedAt: t.bigint().notNull(),
}));

/// Cross-season winner ticker reservations — one row per `tickerHash`. Mirrors
/// `FilterLauncher.winnerTickers[hash]`. Once a ticker wins a season, no future
/// season can launch under it. Used by the same pre-flight check above.
export const winnerTickerReservation = onchainTable("winner_ticker_reservation", (t) => ({
  id: t.hex().primaryKey(), // tickerHash
  seasonId: t.bigint().notNull(), // season that produced the winner
  winnerToken: t.hex().notNull(),
  reservedAt: t.bigint().notNull(),
}));

/// Protocol-blocklisted ticker hashes. Mirrors `FilterLauncher.tickerBlocklist`.
/// Seeded with FILTER/WETH/ETH/USDC/USDT/DAI at construction; the multisig adds
/// more via `addTickerToBlocklist`. The launch-form pre-flight check consults
/// this table for the rejection reason.
///
/// CRITICAL: the consuming contract stores the raw `bytes32` and does NOT
/// canonicalise — operators MUST pass `keccak256(bytes(TickerLib.normalize(s)))`.
/// The TS port of `TickerLib.normalize` (this same package, `src/api/ticker.ts`)
/// MUST match Solidity byte-for-byte. See `TickerValidationTest.test_NonCanonicalHashSilentlyStoresWrongSlot`
/// for the documented failure mode if a non-canonical hash is added.
export const tickerBlocklist = onchainTable("ticker_blocklist", (t) => ({
  id: t.hex().primaryKey(), // tickerHash
  blockedAt: t.bigint().notNull(),
}));

// ============================================================ Tournament tables (PR #45)

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

// ============================================================ Operator audit (Epic 1.21)

/// Per-call audit trail of operator actions. Populated from two event sources:
///   - `CreatorFeeDistributor.OperatorActionEmitted` — direct `disableCreatorFee` audit.
///   - `FilterLauncher.TickerBlocked` — derived row (the launcher is byte-budget-excluded
///     from emitting `OperatorActionEmitted` directly; the indexer reconstructs the
///     audit row from the on-chain event + tx `from`).
///
/// Surfaced via `GET /operator/actions` for the operator console's audit-log view
/// (filter by actor / action / date range).
///
/// `params` is the raw bytes payload from the event (or a synthesised equivalent for
/// derived rows). The operator console ABI-decodes per `action` for display.
export const operatorActionLog = onchainTable("operator_action_log", (t) => ({
  id: t.text().primaryKey(), // `${txHash}:${logIndex}`
  actor: t.hex().notNull(),
  action: t.text().notNull(),
  /// ABI-encoded params blob. Decoded client-side per `action` (e.g.
  /// `disableCreatorFee` decodes as `(address token, string reason)`,
  /// `addTickerToBlocklist` decodes as `(bytes32 tickerHash)`).
  params: t.text().notNull(), // hex string, including 0x prefix
  txHash: t.hex().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
}));
