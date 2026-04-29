import type {Address, Hex} from "viem";

import type {BonusPayload} from "./bonus.js";
import type {SettlementPayload} from "./types.js";

/// Per-user JSON shape published by the oracle for the rollover claim flow.
/// Bigints are encoded as decimal strings — JSON has no native bigint, and the web app's
/// `BigInt(...)` constructor accepts both numeric strings and numbers.
export interface RolloverClaimEntry {
  seasonId: string;
  vault: Address;
  share: string;
  proof: ReadonlyArray<Hex>;
}

/// Per-user JSON shape published for the bonus claim flow.
export interface BonusClaimEntry {
  seasonId: string;
  distributor: Address;
  amount: string;
  proof: ReadonlyArray<Hex>;
}

/// Split a settlement payload into per-user JSON entries keyed by lowercase address.
/// The operator publishes these (as static files behind a CDN, or via the indexer's
/// HTTP API) and users paste their entry into the web app's claim flow.
///
/// `vault` is the per-season vault address — required because the on-chain `claimRollover`
/// call goes to that vault, but it isn't part of the payload itself (the oracle composes
/// it after `SeasonVault` deployment).
export function splitSettlementForPublication(
  payload: SettlementPayload,
  vault: Address,
  seasonId: bigint,
): Record<Address, RolloverClaimEntry> {
  const out: Record<Address, RolloverClaimEntry> = {};
  for (const e of payload.tree.entries) {
    out[e.user.toLowerCase() as Address] = {
      seasonId: seasonId.toString(),
      vault,
      share: e.share.toString(),
      proof: e.proof,
    };
  }
  return out;
}

/// Split a bonus payload into per-user JSON entries keyed by lowercase address.
/// Bonus uses concrete WETH amounts (not abstract shares) because the reserve is fixed
/// at finalize time — see `buildBonusPayload`.
export function splitBonusForPublication(
  payload: BonusPayload,
  distributor: Address,
  seasonId: bigint,
): Record<Address, BonusClaimEntry> {
  const out: Record<Address, BonusClaimEntry> = {};
  for (const e of payload.entries) {
    out[e.user.toLowerCase() as Address] = {
      seasonId: seasonId.toString(),
      distributor,
      amount: e.amount.toString(),
      proof: e.proof,
    };
  }
  return out;
}
