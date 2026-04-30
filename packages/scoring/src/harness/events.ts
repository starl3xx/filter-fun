import type {Address, Phase} from "../types.js";

/// Discriminated union of every event the harness understands. Scenarios
/// (synthetic or historical) are reduced to an ordered, timestamped event
/// stream and replayed deterministically.
///
/// All `ts` are seconds since the simulation start (`bigint` to match the
/// scoring package's bigint timestamps and avoid 53-bit float drift on
/// long-running historical replays). Amounts are in WETH raw units (1e18
/// per WETH), matching `TokenStats` semantics.
///
/// Historical adapters (Track E: Clanker / Bankr / Liquid corpus) emit the
/// same event shape — only the source differs.
export type HarnessEvent =
  | LaunchEvent
  | BuyEvent
  | SellEvent
  | LpAddEvent
  | LpRemoveEvent
  | TimeAdvanceEvent
  | PhaseEvent;

/// Token enters the cohort. Subsequent events reference its address.
/// `initialLpWeth` seeds the pool depth and is recorded as an LP_ADD with
/// `protocol: true` (filter-event LP, not market signal — see spec §6.4.3
/// indexer-responsibility note carried over from the live system).
export interface LaunchEvent {
  type: "LAUNCH";
  ts: bigint;
  token: Address;
  initialLpWeth: bigint;
}

/// A wallet purchases. Adds to the wallet's cumulative `volumeByWallet`,
/// appends to `buys`, and credits the wallet's holder balance by `amountWeth`
/// (1:1 — the harness doesn't model price slippage; HP cares about flow
/// signal, not exact token amounts).
export interface BuyEvent {
  type: "BUY";
  ts: bigint;
  token: Address;
  wallet: Address;
  amountWeth: bigint;
}

/// A wallet sells. Appends to `sells` and debits the wallet's holder balance
/// (clamped at zero — the harness rejects oversells silently rather than
/// tracking shorts; scoring doesn't care).
export interface SellEvent {
  type: "SELL";
  ts: bigint;
  token: Address;
  wallet: Address;
  amountWeth: bigint;
}

/// LP added to the pool. `protocol: true` means a system action (POL
/// accumulation, filter-event redeposit) that should NOT be counted as
/// market-driven liquidity churn. Scoring's sticky-liq penalty only
/// considers user-driven removes; the harness mirrors that contract by
/// excluding `protocol: true` from `recentLiquidityRemovedWeth`.
export interface LpAddEvent {
  type: "LP_ADD";
  ts: bigint;
  token: Address;
  amountWeth: bigint;
  protocol?: boolean;
}

/// LP removed from the pool. See LpAddEvent comment re: `protocol: true`.
export interface LpRemoveEvent {
  type: "LP_REMOVE";
  ts: bigint;
  token: Address;
  amountWeth: bigint;
  protocol?: boolean;
}

/// No state mutation; just advances the simulation clock to `ts`. Useful in
/// scenario builders to skip ahead without manufacturing dummy buys.
export interface TimeAdvanceEvent {
  type: "TIME_ADVANCE";
  ts: bigint;
}

/// Switch the active scoring phase mid-simulation. Mirrors the
/// pre-filter → finals transition that happens at the first cut-line in a
/// real season. The engine applies the new phase to subsequent ticks.
export interface PhaseEvent {
  type: "PHASE";
  ts: bigint;
  phase: Phase;
}
