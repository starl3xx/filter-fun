"use client";

import type {Address} from "viem";
import {zeroAddress} from "viem";
import {useReadContract} from "wagmi";

import deployment from "@/lib/deployment.json";
import {FilterLauncherReadAbi} from "@/lib/token/abis";

/// Refundable-stake status for a token. Maps `LaunchInfo.refunded` and
/// `LaunchInfo.filteredEarly` from FilterLauncher to one of:
///
///   "HELD"      — stake is locked, awaiting first cut resolution
///   "REFUNDED"  — survived the soft filter, stake returned to creator
///   "FORFEITED" — filtered early, stake redirected to forfeitRecipient
///   "PROTOCOL"  — protocol-launched (no stake; e.g. $FILTER seed)
///   "UNKNOWN"   — token not registered in this season (shouldn't happen on a
///                 valid admin-console route, but the UI tolerates it)

export type StakeState = "HELD" | "REFUNDED" | "FORFEITED" | "PROTOCOL" | "UNKNOWN";

export type StakeStatus = {
  state: StakeState;
  /// Original cost paid (wei) — reflects the slot pricing curve, not just the
  /// current stake amount (which goes to zero on resolution).
  costPaid: bigint;
  /// Live stake amount in wei — non-zero only while state === "HELD".
  stakeAmount: bigint;
  /// Slot index this token landed in (0-indexed). Useful context for the UI.
  slotIndex: number;
};

const LAUNCHER_ADDRESS = deployment.addresses.filterLauncher as Address;

export function useStakeStatus(token: Address | null, seasonId: bigint | null): {
  status: StakeStatus;
  isLoading: boolean;
  error: Error | null;
} {
  const enabled = Boolean(token) && seasonId !== null && LAUNCHER_ADDRESS !== zeroAddress;

  const launchInfo = useReadContract({
    address: LAUNCHER_ADDRESS,
    abi: FilterLauncherReadAbi,
    functionName: "launchInfoOf",
    args: token && seasonId !== null ? [seasonId, token] : undefined,
    query: {enabled, refetchInterval: 30_000},
  });

  const entry = useReadContract({
    address: LAUNCHER_ADDRESS,
    abi: FilterLauncherReadAbi,
    functionName: "entryOf",
    args: token && seasonId !== null ? [seasonId, token] : undefined,
    query: {enabled, refetchInterval: 60_000},
  });

  const isLoading = enabled && (launchInfo.isLoading || entry.isLoading);
  const error = launchInfo.error ?? entry.error ?? null;

  const status = computeStatus(
    launchInfo.data as
      | {slotIndex: bigint; costPaid: bigint; stakeAmount: bigint; refunded: boolean; filteredEarly: boolean}
      | undefined,
    entry.data as
      | {token: Address; isProtocolLaunched: boolean}
      | undefined,
  );

  return {status, isLoading, error};
}

function computeStatus(
  info: {slotIndex: bigint; costPaid: bigint; stakeAmount: bigint; refunded: boolean; filteredEarly: boolean} | undefined,
  entry: {token: Address; isProtocolLaunched: boolean} | undefined,
): StakeStatus {
  if (!info || !entry) {
    return {state: "UNKNOWN", costPaid: 0n, stakeAmount: 0n, slotIndex: 0};
  }
  if (entry.isProtocolLaunched) {
    return {state: "PROTOCOL", costPaid: 0n, stakeAmount: 0n, slotIndex: Number(info.slotIndex)};
  }
  if (info.refunded) {
    return {state: "REFUNDED", costPaid: info.costPaid, stakeAmount: 0n, slotIndex: Number(info.slotIndex)};
  }
  if (info.filteredEarly) {
    return {state: "FORFEITED", costPaid: info.costPaid, stakeAmount: 0n, slotIndex: Number(info.slotIndex)};
  }
  return {
    state: "HELD",
    costPaid: info.costPaid,
    stakeAmount: info.stakeAmount,
    slotIndex: Number(info.slotIndex),
  };
}
