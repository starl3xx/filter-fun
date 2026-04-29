import type {Address, Hash} from "viem";

import type {SettlementPayload} from "@filter-fun/oracle";

import {finalizeCall, liquidateCall, submitSettlementCall, type ContractCallShape} from "./calls.js";

/// Narrow signer + receipt interface. Real callers pass viem's `WalletClient` +
/// `PublicClient`; tests pass mocks. The structural `ContractCallShape` keeps writeContract
/// abi-agnostic — both vault and launcher call builders satisfy it.
export interface TransactionDriver {
  /// Send a transaction; returns the transaction hash once submitted (NOT mined).
  writeContract: (call: ContractCallShape) => Promise<Hash>;
  /// Block until the transaction is mined; throw on revert.
  waitForReceipt: (hash: Hash) => Promise<void>;
}

export interface SettlementRunResult {
  submitTx: Hash;
  liquidateTxs: ReadonlyArray<{loser: Address; tx: Hash}>;
  finalizeTx: Hash;
}

export interface SettlementRunOptions {
  /// Optional per-loser slippage override. Defaults to 0 (use the floor encoded on-chain
  /// at submitSettlement time). Operators may pass a higher value to widen the floor for
  /// a specific loser if recovered liquidity has shifted since payload-build time.
  minOutOverrides?: ReadonlyMap<Address, bigint>;
  /// Optional finalize slippage guards. Default 0 (accept any AMM output).
  minWinnerTokensRollover?: bigint;
  minWinnerTokensPol?: bigint;
}

/// Drives a season through `submitSettlement → liquidate(loser) → finalize`.
/// Sequential by design — finalize must wait until every liquidation has mined.
/// Liquidations themselves run sequentially to keep nonce management trivial; if you
/// want parallel keepers, use `liquidateCall(...)` directly and manage nonces yourself.
export async function runSettlement(
  driver: TransactionDriver,
  vault: Address,
  payload: SettlementPayload,
  opts: SettlementRunOptions = {},
): Promise<SettlementRunResult> {
  // 1. submitSettlement — oracle-only, posts the ranking + Merkle root.
  const submitTx = await driver.writeContract(submitSettlementCall(vault, payload));
  await driver.waitForReceipt(submitTx);

  // 2. liquidate each loser. Sequential so the wallet's nonce stays sane.
  const liquidateTxs: Array<{loser: Address; tx: Hash}> = [];
  for (const loser of payload.losers) {
    const minOut = opts.minOutOverrides?.get(loser) ?? 0n;
    const tx = await driver.writeContract(liquidateCall(vault, loser, minOut));
    await driver.waitForReceipt(tx);
    liquidateTxs.push({loser, tx});
  }

  // 3. finalize — allocates the pot, AMM-buys winner tokens for rollover + POL.
  const finalizeTx = await driver.writeContract(
    finalizeCall(
      vault,
      opts.minWinnerTokensRollover ?? 0n,
      opts.minWinnerTokensPol ?? 0n,
    ),
  );
  await driver.waitForReceipt(finalizeTx);

  return {submitTx, liquidateTxs, finalizeTx};
}
