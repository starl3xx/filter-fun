"use client";

/// Supply + mint-config reads for the /club mint page (Epic 2.6 / spec
/// §47.3.8).
///
/// Reads the whole mint surface in one `useReadContracts` batch:
/// `totalMinted` / `maxSupply` drive the progress bar, `mintPrice` the exact
/// wei total, `walletMintCap` + `mintedBy(me)` the stepper's upper bound, and
/// `paused` the emergency-stop state. 8s refetch mirrors useLaunchSlots — a
/// mint landing in another tab moves the bar before the user's next click.
///
/// `mintedBy` reads with the zero address while disconnected (same pattern as
/// useEligibility's `launchesByWallet`) — the result is 0 and harmless, and
/// keeping the contracts array shape stable avoids a wagmi query-key churn.

import {useAccount, useReadContracts} from "wagmi";

import {contractAddresses, isDeployed} from "@/lib/addresses";
import {FilterClubPassAbi} from "@/lib/club/abi";

export type ClubSupplyResult = {
  /// Null until the batch read lands (or forever, pre-deploy) — consumers
  /// render skeleton/dash states off the null, never a lying zero
  /// (M-Ux-4 discipline).
  data: {
    totalMinted: bigint;
    maxSupply: bigint;
    mintPriceWei: bigint;
    walletMintCap: bigint;
    mintedByWallet: bigint;
    paused: boolean;
  } | null;
  isLoading: boolean;
  error: Error | null;
};

export function useClubSupply(): ClubSupplyResult {
  const {address} = useAccount();

  const enabled = isDeployed("filterClubPass");
  const pass = contractAddresses.filterClubPass;
  const wallet = address ?? "0x0000000000000000000000000000000000000000";

  const {data, isLoading, error} = useReadContracts({
    contracts: [
      {address: pass, abi: FilterClubPassAbi, functionName: "totalMinted"},
      {address: pass, abi: FilterClubPassAbi, functionName: "maxSupply"},
      {address: pass, abi: FilterClubPassAbi, functionName: "mintPrice"},
      {address: pass, abi: FilterClubPassAbi, functionName: "walletMintCap"},
      {address: pass, abi: FilterClubPassAbi, functionName: "mintedBy", args: [wallet]},
      {address: pass, abi: FilterClubPassAbi, functionName: "paused"},
    ],
    query: {enabled, refetchInterval: 8_000},
  });

  const totalMinted = data?.[0]?.result as bigint | undefined;
  const maxSupply = data?.[1]?.result as bigint | undefined;
  const mintPriceWei = data?.[2]?.result as bigint | undefined;
  const walletMintCap = data?.[3]?.result as number | bigint | undefined;
  const mintedByWallet = data?.[4]?.result as number | bigint | undefined;
  const paused = data?.[5]?.result as boolean | undefined;

  // All-or-nothing: a partially-resolved batch renders as loading rather
  // than mixing real values with fallback zeros (a zero maxSupply would
  // read as "mint not live" — a lie while the read is merely slow).
  const ready =
    totalMinted !== undefined &&
    maxSupply !== undefined &&
    mintPriceWei !== undefined &&
    walletMintCap !== undefined &&
    mintedByWallet !== undefined &&
    paused !== undefined;

  return {
    data: ready
      ? {
          totalMinted,
          maxSupply,
          mintPriceWei,
          // uint32 returns decode as `number` in viem; normalize to bigint so
          // the clamp math in lib/club/mint.ts stays single-typed.
          walletMintCap: BigInt(walletMintCap),
          mintedByWallet: BigInt(mintedByWallet),
          paused,
        }
      : null,
    isLoading: enabled && isLoading,
    error: (error as Error | null) ?? null,
  };
}
