/// EXCLUDED_TRADERS — addresses that are filtered out of velocity +
/// effective-buyers attribution before scoring (spec §6.4.7 + §41.3).
///
/// **What's in here.**
///   - Protocol contracts whose balances/trades are not real participants
///     (PoolManager, FilterLpLocker, FilterFactory, vaults).
///   - Common burn addresses.
///   - A maintained MEV-bot list (env-overridable for live updates without
///     a code release — `EXCLUDED_TRADERS_EXTRA` is a comma-separated lower-
///     cased address list parsed at indexer boot).
///
/// **What's NOT in here.**
///   - Universal routers / aggregators. Those are handled by `tx.from`
///     attribution at the indexer's swap-event handler, NOT by exclusion —
///     a router-routed buy from a real EOA is a real buy that should count.
///     Exclude the router and you also exclude every legitimate trader
///     who routes through it.
///
/// **How it's applied.** The indexer's projection layer (Epic 1.22b — PR 2)
/// filters `volumeByWallet`, `currentHolders`, `holdersAtRetentionAnchor`
/// against this set BEFORE handing `TokenStats` to the scoring engine. The
/// engine itself is pure and trusts whatever set it's given; the boundary
/// where exclusion lives is the indexer.
///
/// Lower-cased throughout. Address comparisons in JS/TS are case-insensitive
/// by convention but Set membership is byte-exact, so callers MUST lowercase
/// addresses before testing membership.

import type {Address} from "./types.js";

/// Lower-cased burn / sentinel addresses. Includes 0x000…000 (zero) and
/// 0x000…001 (sometimes used as a sentinel) along with the 0xdEaD burn
/// convention.
const BURN_ADDRESSES: readonly Address[] = [
  "0x0000000000000000000000000000000000000000" as Address,
  "0x0000000000000000000000000000000000000001" as Address,
  "0x000000000000000000000000000000000000dead" as Address,
];

/// Build the active EXCLUDED_TRADERS set. Static protocol addresses are
/// pulled from a deployment manifest (resolved by the caller — the scoring
/// package can't read manifests directly). Burn addresses are baked in.
/// MEV-bot extras come from the `EXCLUDED_TRADERS_EXTRA` env var (CSV of
/// lower-cased addresses) so operators can update the list without a redeploy.
///
/// @param protocolAddresses lower-cased addresses for the protocol's own
///   contracts (PoolManager, FilterLpLocker per token, FilterFactory, season
///   vault, POL vault). The indexer derives these from
///   `packages/contracts/deployments/*.json` and per-token locker rows.
/// @param env `process.env`-shaped record. Reads `EXCLUDED_TRADERS_EXTRA`.
export function buildExcludedTraders(
  protocolAddresses: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>> = {},
): ReadonlySet<Address> {
  const set = new Set<Address>();
  for (const a of BURN_ADDRESSES) set.add(a);
  for (const a of protocolAddresses) set.add(a.toLowerCase() as Address);
  const extra = (env.EXCLUDED_TRADERS_EXTRA ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
  for (const a of extra) set.add(a as Address);
  return set;
}

/// Convenience: filter a `Map<Address, T>` by removing excluded keys. Used
/// by the indexer projection on `volumeByWallet` (and equivalent shapes)
/// before scoring sees the input.
export function filterExcluded<T>(
  m: ReadonlyMap<Address, T>,
  excluded: ReadonlySet<Address>,
): Map<Address, T> {
  const out = new Map<Address, T>();
  for (const [k, v] of m) {
    if (!excluded.has(k.toLowerCase() as Address)) out.set(k, v);
  }
  return out;
}

/// Convenience: filter a `Set<Address>` by removing excluded entries.
export function filterExcludedSet(
  s: ReadonlySet<Address>,
  excluded: ReadonlySet<Address>,
): Set<Address> {
  const out = new Set<Address>();
  for (const a of s) {
    if (!excluded.has(a.toLowerCase() as Address)) out.add(a);
  }
  return out;
}

export {BURN_ADDRESSES};
