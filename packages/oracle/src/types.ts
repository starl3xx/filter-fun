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

/// Per-loser, the LP's recoverable WETH at filter-event time and the slippage budget the
/// liquidation step is allowed to accept. Caller produces this from on-chain quotes.
export interface RecoverableQuote {
  token: Address;
  recoverableWeth: bigint;
}

/// One filter event's worth of cuts. The vault liquidates these and splits the proceeds per
/// the user-aligned BPS (45/25/10/10/10) at the moment this is submitted.
export interface FilterEventInputs {
  /// Tokens to filter at this cut.
  losers: ReadonlyArray<Address>;
  /// Per-loser recoverable WETH (used to compute the liquidation floor).
  recoverable: ReadonlyMap<Address, bigint>;
  /// BPS of slippage allowed. minOut = recoverable * (10_000 - slippageBps) / 10_000.
  slippageBps: number;
}

export interface FilterEventPayload {
  /// Calldata-shaped fields ordered to match `SeasonVault.processFilterEvent`.
  losers: ReadonlyArray<Address>;
  minOuts: ReadonlyArray<bigint>;
}

/// Final-settlement inputs: the winner + accumulated rollover share weights across ALL
/// filter events. Bonus eligibility is computed off-chain from the rollover amounts only.
export interface SettlementInputs {
  /// The winning token. Must NOT have been included in any prior filter event.
  winner: Address;
  /// Per-wallet rollover share weights — cumulative across the season's filter events.
  /// The user's bonus eligibility (if they hold ≥80% across snapshots) yields a bonus
  /// allocation derived from THIS share, not from raw token balance.
  shares: ReadonlyMap<Address, bigint>;
  /// Slippage guard for the rollover-side AMM purchase at submitWinner. 0 = accept any.
  minWinnerTokensRollover?: bigint;
  /// Slippage guard for the POL deployment swap at submitWinner. 0 = accept any.
  minWinnerTokensPol?: bigint;
}

export interface SettlementPayload {
  /// Calldata-shaped fields ordered to match `SeasonVault.submitWinner`.
  winner: Address;
  rolloverRoot: Hex;
  totalRolloverShares: bigint;
  minWinnerTokensRollover: bigint;
  minWinnerTokensPol: bigint;
  /// Sidecar artifact: the full Merkle tree the off-chain claim service serves to users.
  /// Not part of the on-chain submitWinner call.
  tree: RolloverTree;
}
