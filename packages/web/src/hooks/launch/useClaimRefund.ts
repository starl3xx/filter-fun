"use client";

/// `claimPendingRefund(seasonId, to)` write hook — Epic 1.15c.
///
/// Resolves the `LaunchEscrow` address via `FilterLauncher.launchEscrow()` (an
/// on-chain read; the address isn't currently in the deployment manifest the
/// web bundle ships with), then submits the `claimPendingRefund` tx. The
/// `to` recipient defaults to the connected wallet — the contract enforces
/// `to` is the creator-of-record, so the only safe value is the wallet that
/// originally reserved.

import {useCallback, useState} from "react";
import {useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt} from "wagmi";

import {contractAddresses, isDeployed} from "@/lib/addresses";
import {
  FilterLauncherEscrowGetterAbi,
  FilterLauncherLaunchAbi,
  LaunchEscrowAbi,
} from "@/lib/launch/abi";

export type ClaimPhase = "idle" | "signing" | "broadcasting" | "success" | "error";

export type UseClaimRefundResult = {
  phase: ClaimPhase;
  error: string | null;
  /// Submit the claim. Returns once the tx is acknowledged (broadcast); the
  /// hook continues to track it via `useWaitForTransactionReceipt` and the
  /// `phase` flips to `success` on confirmation.
  claim: (seasonId: bigint) => Promise<void>;
  /// Reset to idle — drives "Claim again" affordance after a success. Doesn't
  /// touch wagmi's internal queue; the next `claim()` re-reads.
  reset: () => void;
};

export function useClaimRefund(): UseClaimRefundResult {
  const {address} = useAccount();
  const [phase, setPhase] = useState<ClaimPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  // Read the escrow address off the launcher. Static for the lifetime of a
  // deployment; wagmi caches the read so this is single-call per session.
  const {data: launchEscrowAddr} = useReadContract({
    address: contractAddresses.filterLauncher,
    abi: [...FilterLauncherLaunchAbi, ...FilterLauncherEscrowGetterAbi],
    functionName: "launchEscrow",
    query: {enabled: isDeployed("filterLauncher")},
  });

  const {writeContractAsync, data: txHash} = useWriteContract();
  const {isLoading: confirming, isSuccess: confirmed} = useWaitForTransactionReceipt({
    hash: txHash,
    query: {enabled: !!txHash},
  });

  // Drive `phase` from the receipt watcher.
  if (txHash && confirming && phase !== "broadcasting") setPhase("broadcasting");
  if (txHash && confirmed && phase !== "success") setPhase("success");

  const claim = useCallback(
    async (seasonId: bigint) => {
      if (!address) {
        setError("Connect your wallet to claim");
        setPhase("error");
        return;
      }
      if (!launchEscrowAddr) {
        setError("Launch escrow address unavailable");
        setPhase("error");
        return;
      }
      setError(null);
      setPhase("signing");
      try {
        await writeContractAsync({
          address: launchEscrowAddr,
          abi: LaunchEscrowAbi,
          functionName: "claimPendingRefund",
          args: [seasonId, address],
        });
        // wagmi's receipt watcher will flip `phase` to `broadcasting` → `success`
        // as the chain confirms. Keep the awaited form here so callers can
        // treat the promise as "tx accepted by wallet".
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    },
    [address, launchEscrowAddr, writeContractAsync],
  );

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
  }, []);

  return {phase, error, claim, reset};
}
