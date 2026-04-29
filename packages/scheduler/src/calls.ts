import type {Address, Hex} from "viem";

import type {FilterEventPayload, SettlementPayload} from "@filter-fun/oracle";

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

/// Builds the call for a single filter event (one cut). Multiple of these are dispatched
/// across the week as the oracle decides which tokens to filter at each cut.
export function processFilterEventCall(
  vault: Address,
  payload: FilterEventPayload,
): ContractCall<"processFilterEvent"> {
  return {
    address: vault,
    abi: SeasonVaultAbi,
    functionName: "processFilterEvent",
    args: [payload.losers, payload.minOuts],
  };
}

/// Builds the final-settlement call: oracle commits the winner + rollover Merkle root and
/// the vault drains the accumulated rollover/bonus/POL reserves in one tx.
export function submitWinnerCall(
  vault: Address,
  payload: SettlementPayload,
): ContractCall<"submitWinner"> {
  return {
    address: vault,
    abi: SeasonVaultAbi,
    functionName: "submitWinner",
    args: [
      payload.winner,
      payload.rolloverRoot,
      payload.totalRolloverShares,
      payload.minWinnerTokensRollover,
      payload.minWinnerTokensPol,
    ],
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
