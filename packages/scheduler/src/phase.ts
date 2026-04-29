import type {Address, Hash} from "viem";

import {advancePhaseCall, setFinalistsCall, startSeasonCall} from "./launcherCalls.js";
import {Phase} from "./launcherAbi.js";
import type {TransactionDriver} from "./runner.js";

/// One-shot helper: send the txn, wait for the receipt, return the hash.
async function _send(driver: TransactionDriver, call: ReturnType<typeof advancePhaseCall>): Promise<Hash> {
  const hash = await driver.writeContract(call);
  await driver.waitForReceipt(hash);
  return hash;
}

/// Open a fresh season. Oracle-only on-chain. Returns the txn hash; the caller can read
/// `currentSeasonId` afterwards (or parse the `SeasonStarted` event) to learn the new id.
export async function startSeason(driver: TransactionDriver, launcher: Address): Promise<Hash> {
  const hash = await driver.writeContract(startSeasonCall(launcher));
  await driver.waitForReceipt(hash);
  return hash;
}

/// Advance a season's phase by one step. The contract enforces forward-only ordered
/// transitions (`target == current + 1`); skipping reverts.
export async function advancePhase(
  driver: TransactionDriver,
  launcher: Address,
  seasonId: bigint,
  target: Phase,
): Promise<Hash> {
  return _send(driver, advancePhaseCall(launcher, seasonId, target));
}

/// Lock in the set of tokens that pass the filter cut. Must be called while the season is
/// in `Filter` phase. Reverts on unknown token.
export async function setFinalists(
  driver: TransactionDriver,
  launcher: Address,
  seasonId: bigint,
  finalists: ReadonlyArray<Address>,
): Promise<Hash> {
  const hash = await driver.writeContract(setFinalistsCall(launcher, seasonId, finalists));
  await driver.waitForReceipt(hash);
  return hash;
}

/// Drives the oracle-orchestrated arc of a season:
///   Launch → (advance) Filter → (setFinalists) → (advance) Finals → (advance) Settlement
/// Each step is awaited individually so partial-failure leaves clear state.
/// Settlement itself is then driven by `runSettlement` once the oracle posts the payload.
export interface RunPhaseArcResult {
  toFilterTx: Hash;
  setFinalistsTx: Hash;
  toFinalsTx: Hash;
  toSettlementTx: Hash;
}

export async function runPhaseArc(
  driver: TransactionDriver,
  launcher: Address,
  seasonId: bigint,
  finalists: ReadonlyArray<Address>,
): Promise<RunPhaseArcResult> {
  if (finalists.length === 0) {
    throw new Error("runPhaseArc: finalists must be non-empty (at least the winner-elect)");
  }
  const toFilterTx = await advancePhase(driver, launcher, seasonId, Phase.Filter);
  const setFinalistsTx = await setFinalists(driver, launcher, seasonId, finalists);
  const toFinalsTx = await advancePhase(driver, launcher, seasonId, Phase.Finals);
  const toSettlementTx = await advancePhase(driver, launcher, seasonId, Phase.Settlement);
  return {toFilterTx, setFinalistsTx, toFinalsTx, toSettlementTx};
}
