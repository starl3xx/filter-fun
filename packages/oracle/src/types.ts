import type {Address, Hex} from "viem";

export type {Address, Hex};

export interface RolloverLeaf {
  user: Address;
  share: bigint;
}

export interface RolloverEntry extends RolloverLeaf {
  proof: ReadonlyArray<Hex>;
}

export interface RolloverTree {
  root: Hex;
  totalShares: bigint;
  entries: ReadonlyArray<RolloverEntry>;
}

/// Per-loser, the LP's recoverable USDC at settlement time and the slippage budget the
/// liquidation keeper is allowed to accept. Caller produces this from on-chain quotes.
export interface RecoverableQuote {
  token: Address;
  recoverableUsdc: bigint;
}

export interface SettlementInputs {
  /// Tokens currently in the season, ranked. Index 0 is the winner.
  ranking: ReadonlyArray<Address>;
  /// Per-loser recoverable USDC (used to compute the liquidation floor).
  recoverable: ReadonlyMap<Address, bigint>;
  /// BPS of slippage allowed when liquidating each loser. minOut = recoverable * (10_000 - slippageBps) / 10_000.
  slippageBps: number;
  /// Per-wallet rollover share weights. Caller computes these from holder snapshots —
  /// e.g. weighted balance × time-held across the season for each loser-token holder.
  shares: ReadonlyMap<Address, bigint>;
  /// Unix timestamp by which liquidation must complete; passed straight to the contract.
  liquidationDeadline: bigint;
}

export interface SettlementPayload {
  /// Calldata-shaped fields, ordered to match `SeasonVault.submitSettlement`.
  winner: Address;
  losers: ReadonlyArray<Address>;
  minOuts: ReadonlyArray<bigint>;
  rolloverRoot: Hex;
  totalRolloverShares: bigint;
  liquidationDeadline: bigint;
  /// Sidecar artifact: the full Merkle tree the off-chain claim service serves to users.
  /// Not part of the on-chain submitSettlement call.
  tree: RolloverTree;
}
