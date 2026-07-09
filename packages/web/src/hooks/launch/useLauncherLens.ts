"use client";

/// Resolves the `LauncherLens` address off the launcher (`launcher.lens()`, an
/// immutable set in the launcher's constructor) — the same runtime-resolution
/// pattern `useClaimRefund` uses for `launchEscrow()`. Static for the lifetime
/// of a deployment; wagmi caches the read so this is single-call per session.
///
/// Epic 1.15a drift fix: the /launch read surface (`getLaunchStatus`,
/// `getLaunchSlots`, `canReserve`) lives on the lens companion, not the
/// launcher — the launcher externalized its convenience views to stay under
/// EIP-170. Reads addressed to the launcher revert.

import {useReadContract} from "wagmi";

import {contractAddresses, isDeployed} from "@/lib/addresses";
import {FilterLauncherLensGetterAbi} from "@/lib/launch/abi";

export function useLauncherLens(): {lensAddress: `0x${string}` | undefined} {
  const {data} = useReadContract({
    address: contractAddresses.filterLauncher,
    abi: FilterLauncherLensGetterAbi,
    functionName: "lens",
    query: {enabled: isDeployed("filterLauncher"), staleTime: Infinity},
  });
  return {lensAddress: data as `0x${string}` | undefined};
}
