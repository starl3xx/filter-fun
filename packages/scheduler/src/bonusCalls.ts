import type {Address, Hex} from "viem";

import {BonusDistributorAbi} from "./bonusAbi.js";

/// Same shape as `ContractCall` from calls.ts, but specialized to the BonusDistributor ABI.
export interface BonusCall<TFunctionName extends string> {
  address: Address;
  abi: typeof BonusDistributorAbi;
  functionName: TFunctionName;
  args: ReadonlyArray<unknown>;
}

/// Oracle-only. Posts the eligibility Merkle root after the 14-day hold window — must be
/// called after `block.timestamp >= unlockTime` or the contract reverts with `NotUnlocked`.
export function postBonusRootCall(
  bonusDistributor: Address,
  seasonId: bigint,
  root: Hex,
): BonusCall<"postRoot"> {
  return {
    address: bonusDistributor,
    abi: BonusDistributorAbi,
    functionName: "postRoot",
    args: [seasonId, root],
  };
}

/// Permissionless — `msg.sender` claims their own bonus. The oracle's
/// `buildBonusPayload` output gives the (amount, proof) pair to pass here.
export function claimBonusCall(
  bonusDistributor: Address,
  seasonId: bigint,
  amount: bigint,
  proof: ReadonlyArray<Hex>,
): BonusCall<"claim"> {
  return {
    address: bonusDistributor,
    abi: BonusDistributorAbi,
    functionName: "claim",
    args: [seasonId, amount, proof],
  };
}
