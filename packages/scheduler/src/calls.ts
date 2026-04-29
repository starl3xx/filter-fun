import type {Address, Hex} from "viem";

import type {SettlementPayload} from "@filter-fun/oracle";

import {SeasonVaultAbi} from "./abi.js";

/// Each builder returns a `writeContract`-shaped object. Pure: no network, no signer.
/// Operators can either pass these straight to `walletClient.writeContract`, or feed them
/// into a multisig (Safe) UI as transaction-batch JSON.

/// Structural shape every call builder satisfies. Used by `TransactionDriver.writeContract`
/// so the driver can accept calls against any ABI (vault, launcher, …) without a generic
/// param. Builders return more specific types (`ContractCall`, `LauncherCall`) for tooling.
export interface ContractCallShape {
  address: Address;
  abi: ReadonlyArray<unknown>;
  functionName: string;
  args: ReadonlyArray<unknown>;
}

export interface ContractCall<TFunctionName extends string> {
  address: Address;
  abi: typeof SeasonVaultAbi;
  functionName: TFunctionName;
  args: ReadonlyArray<unknown>;
}

export function submitSettlementCall(
  vault: Address,
  payload: SettlementPayload,
): ContractCall<"submitSettlement"> {
  return {
    address: vault,
    abi: SeasonVaultAbi,
    functionName: "submitSettlement",
    args: [
      payload.winner,
      payload.losers,
      payload.minOuts,
      payload.rolloverRoot,
      payload.totalRolloverShares,
      payload.liquidationDeadline,
    ],
  };
}

export function liquidateCall(
  vault: Address,
  loser: Address,
  minOutOverride: bigint = 0n,
): ContractCall<"liquidate"> {
  return {
    address: vault,
    abi: SeasonVaultAbi,
    functionName: "liquidate",
    args: [loser, minOutOverride],
  };
}

export function finalizeCall(
  vault: Address,
  minWinnerTokensRollover: bigint = 0n,
  minWinnerTokensPol: bigint = 0n,
): ContractCall<"finalize"> {
  return {
    address: vault,
    abi: SeasonVaultAbi,
    functionName: "finalize",
    args: [minWinnerTokensRollover, minWinnerTokensPol],
  };
}

export function claimRolloverCall(
  vault: Address,
  share: bigint,
  proof: ReadonlyArray<Hex>,
): ContractCall<"claimRollover"> {
  return {
    address: vault,
    abi: SeasonVaultAbi,
    functionName: "claimRollover",
    args: [share, proof],
  };
}
