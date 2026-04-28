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
export const feeAccrual = onchainTable("fee_accrual", (t) => ({
  id: t.text().primaryKey(), // `${tx}:${logIndex}`
  token: t.hex().notNull(),
  asset: t.hex().notNull(),
  toVault: t.bigint().notNull(),
  toTreasury: t.bigint().notNull(),
  toMechanics: t.bigint().notNull(),
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
