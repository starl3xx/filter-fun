import type {Address, Hash, Hex} from "viem";

import type {BonusPayload} from "@filter-fun/oracle";

import {claimBonusCall, postBonusRootCall} from "./bonusCalls.js";
import type {TransactionDriver} from "./runner.js";

/// Oracle posts the eligibility Merkle root after the 14-day hold window. The contract
/// rejects this if the bonus isn't funded or if `unlockTime` hasn't been reached, so the
/// caller is responsible for sequencing this after `SeasonVault.finalize` and the wait.
export async function postBonusRoot(
  driver: TransactionDriver,
  bonusDistributor: Address,
  seasonId: bigint,
  payload: BonusPayload,
): Promise<Hash> {
  const hash = await driver.writeContract(postBonusRootCall(bonusDistributor, seasonId, payload.root));
  await driver.waitForReceipt(hash);
  return hash;
}

/// Permissionless — submitted by the eligible holder themselves. Operators rarely need
/// this (the web app is the primary caller); included for batch-claim scripts and tests.
export async function claimBonus(
  driver: TransactionDriver,
  bonusDistributor: Address,
  seasonId: bigint,
  amount: bigint,
  proof: ReadonlyArray<Hex>,
): Promise<Hash> {
  const hash = await driver.writeContract(claimBonusCall(bonusDistributor, seasonId, amount, proof));
  await driver.waitForReceipt(hash);
  return hash;
}
