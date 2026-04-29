import type {Address, Hash} from "viem";

import type {FilterEventPayload, SettlementPayload} from "@filter-fun/oracle";

import {processFilterEventCall, submitWinnerCall, type ContractCallShape} from "./calls.js";

/// Narrow signer + receipt interface. Real callers pass viem's `WalletClient` +
/// `PublicClient`; tests pass mocks. The structural `ContractCallShape` keeps writeContract
/// abi-agnostic — both vault and launcher call builders satisfy it.
export interface TransactionDriver {
  /// Send a transaction; returns the transaction hash once submitted (NOT mined).
  writeContract: (call: ContractCallShape) => Promise<Hash>;
  /// Block until the transaction is mined; throw on revert.
  waitForReceipt: (hash: Hash) => Promise<void>;
}

export interface FilterEventRunResult {
  /// One tx per call to `processFilterEvent` (one per cut).
  filterEventTxs: ReadonlyArray<Hash>;
}

export interface SettlementRunResult extends FilterEventRunResult {
  /// Final winner-submit tx — drains rollover/bonus/POL reserves.
  submitWinnerTx: Hash;
}

/// Send a single filter-event tx (one cut). Caller is responsible for sequencing across the
/// week — typically one of these per scheduled cut, with `runSettlement` at the end of week.
export async function runFilterEvent(
  driver: TransactionDriver,
  vault: Address,
  payload: FilterEventPayload,
): Promise<Hash> {
  const tx = await driver.writeContract(processFilterEventCall(vault, payload));
  await driver.waitForReceipt(tx);
  return tx;
}

/// Drives a full season: any pending filter events first (one tx each), then the final
/// `submitWinner` which drains the accumulated reserves and deploys POL into the winner.
///
/// Sequential by design — `submitWinner` must wait until each filter event has mined so the
/// reserves are correct when the winner is committed.
export async function runSettlement(
  driver: TransactionDriver,
  vault: Address,
  pendingFilters: ReadonlyArray<FilterEventPayload>,
  payload: SettlementPayload,
): Promise<SettlementRunResult> {
  const filterEventTxs: Hash[] = [];
  for (const evt of pendingFilters) {
    filterEventTxs.push(await runFilterEvent(driver, vault, evt));
  }

  const submitWinnerTx = await driver.writeContract(submitWinnerCall(vault, payload));
  await driver.waitForReceipt(submitWinnerTx);

  return {filterEventTxs, submitWinnerTx};
}
