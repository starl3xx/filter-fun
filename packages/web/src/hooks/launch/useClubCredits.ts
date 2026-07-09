"use client";

/// Filter Club credit balance for the connected wallet (Epic 2.6 / spec
/// §47.3.8).
///
/// Drives the launch page's "Use Filter Club credit" toggle: when the wallet
/// holds ≥1 credit, `reserve` can be submitted with `value: 0n` and the
/// contract consumes a credit instead of ETH (zero value is unambiguous club
/// intent — see FilterLauncher.reserve step 8).
///
/// Single `creditsRemaining(address)` read — the contract sums `creditsOf`
/// across every owned pass for us, so no per-token fan-out. `balanceOf` rides
/// along so the UI can distinguish "no passes" from "passes drained of
/// credits" ("0 credits left" vs no chip at all).

import {useAccount, useReadContracts} from "wagmi";

import {contractAddresses, isDeployed} from "@/lib/addresses";
import {FilterClubPassAbi} from "@/lib/club/abi";

export type UseClubCreditsResult = {
  /// Sum of credits across every pass the wallet owns. 0n while loading,
  /// disconnected, or pass-not-deployed.
  totalCredits: bigint;
  /// Passes owned by the wallet (`balanceOf`).
  passCount: bigint;
  /// True iff ≥1 credit is spendable — gates the launch-page toggle.
  hasCredit: boolean;
  isLoading: boolean;
};

export function useClubCredits(): UseClubCreditsResult {
  const {address} = useAccount();

  const enabled = isDeployed("filterClubPass") && Boolean(address);
  const pass = contractAddresses.filterClubPass;
  const wallet = address ?? "0x0000000000000000000000000000000000000000";

  const {data, isLoading} = useReadContracts({
    contracts: [
      {
        address: pass,
        abi: FilterClubPassAbi,
        functionName: "creditsRemaining",
        args: [wallet],
      },
      {
        address: pass,
        abi: FilterClubPassAbi,
        functionName: "balanceOf",
        args: [wallet],
      },
    ],
    // 8s cadence mirrors the sibling launch hooks (useLaunchSlots,
    // useEligibility) — a credit consumed in another tab shows up before the
    // user can double-spend it into an InsufficientEscrow revert.
    query: {enabled, refetchInterval: 8_000},
  });

  const totalCredits = (data?.[0]?.result as bigint | undefined) ?? 0n;
  const passCount = (data?.[1]?.result as bigint | undefined) ?? 0n;

  return {
    totalCredits,
    passCount,
    hasCredit: totalCredits > 0n,
    isLoading: enabled && isLoading,
  };
}
