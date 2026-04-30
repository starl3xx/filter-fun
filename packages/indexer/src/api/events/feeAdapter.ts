/// Pure helpers that translate Drizzle fee-accrual rows into the `FeeAccrualRow` shape
/// the detectors consume.
///
/// Why this exists: `feeAccrual.token` in the indexer schema stores the LOCKER address
/// (the per-token `FilterLpLocker` is the `FeesCollected` emitter), not the actual token
/// contract. The detectors look up by token contract address against the cohort snapshot,
/// so a naive pass-through silently broke fee-derived signals (volume spike + large trade)
/// in production — fee rows never matched any token in the snapshot map.
///
/// These helpers do the locker→token resolution client-side using a pre-built map (from
/// `token.locker` rows) and are kept pure so vitest can drive them with fixture rows.

import type {FeeAccrualRow} from "./types.js";

/// Drizzle row shape for `feeAccrual` — narrowed to just the columns we read so this
/// module doesn't have to import the schema directly.
export interface FeeAccrualDbRow {
  /// LOCKER address — emitter of the `FeesCollected` event. Resolved to a token below.
  token: `0x${string}`;
  toVault: bigint;
  toTreasury: bigint;
  toMechanics: bigint;
  blockTimestamp: bigint;
}

/// Drizzle row shape for `token` — minimal projection for the locker→token resolution.
export interface TokenLockerRow {
  /// Token contract address — primary key.
  id: `0x${string}`;
  /// Per-token locker address.
  locker: `0x${string}`;
  seasonId: bigint;
}

/// Build a case-insensitive locker→token map from token rows.
export function lockerToTokenMap(
  rows: ReadonlyArray<TokenLockerRow>,
): Map<string, `0x${string}`> {
  const m = new Map<string, `0x${string}`>();
  for (const r of rows) m.set(r.locker.toLowerCase(), r.id);
  return m;
}

/// Translate raw fee rows into `FeeAccrualRow[]`, filtering out rows whose locker isn't
/// resolvable (e.g. fees from a contract the indexer hasn't seen in the token table).
export function translateFeeRows(
  rows: ReadonlyArray<FeeAccrualDbRow>,
  lockerToToken: ReadonlyMap<string, `0x${string}`>,
): FeeAccrualRow[] {
  const out: FeeAccrualRow[] = [];
  for (const r of rows) {
    const tokenAddr = lockerToToken.get(r.token.toLowerCase());
    if (!tokenAddr) continue;
    out.push({
      tokenAddress: tokenAddr,
      totalFeeWei: r.toVault + r.toTreasury + r.toMechanics,
      blockTimestampSec: r.blockTimestamp,
    });
  }
  return out;
}

/// Aggregate raw fee rows into a token-keyed sum, scoped to the tokens whose lockers
/// appear in `lockerToToken`. Used by `cumulativeFeesByToken` (per-season) and
/// `baselineFees` (trailing-window baseline for the volume-spike detector).
export function aggregateFeesByToken(
  rows: ReadonlyArray<FeeAccrualDbRow>,
  lockerToToken: ReadonlyMap<string, `0x${string}`>,
): Map<`0x${string}`, bigint> {
  const acc = new Map<`0x${string}`, bigint>();
  for (const r of rows) {
    const tokenAddr = lockerToToken.get(r.token.toLowerCase());
    if (!tokenAddr) continue;
    const sum = r.toVault + r.toTreasury + r.toMechanics;
    acc.set(tokenAddr, (acc.get(tokenAddr) ?? 0n) + sum);
  }
  return acc;
}
