"use client";

/// Reads `currentSeasonId` directly from the launcher contract.
///
/// We read on-chain rather than via the indexer's `/season` because the
/// launch flow needs the season the *contract* is going to attribute the
/// launch to. The two values converge under steady state but can diverge
/// briefly across a season-boundary block (the indexer publishes the new
/// season after its commit window, which is mid-block from the contract's
/// view). For the launch page that race is unsafe — we'd quote slot N's
/// cost while the chain has moved to a fresh season at slot 0.

import {useReadContract} from "wagmi";

import {contractAddresses, isDeployed} from "@/lib/addresses";
import {FilterLauncherLaunchAbi} from "@/lib/launch/abi";

export type UseLauncherSeasonResult = {
  data: bigint | null;
  isLoading: boolean;
  error: Error | null;
};

export function useLauncherSeason(): UseLauncherSeasonResult {
  const enabled = isDeployed("filterLauncher");
  const {data, isLoading, error} = useReadContract({
    address: contractAddresses.filterLauncher,
    abi: FilterLauncherLaunchAbi,
    functionName: "currentSeasonId",
    query: {enabled, refetchInterval: 12_000},
  });
  return {
    data: data ?? null,
    isLoading,
    error: error as Error | null,
  };
}
