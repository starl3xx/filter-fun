"use client";

import {useEffect} from "react";
import type {Address} from "viem";
import {zeroAddress} from "viem";
import {useReadContract, useWaitForTransactionReceipt, useWriteContract} from "wagmi";

import deployment from "@/lib/deployment.json";
import {CreatorFeeDistributorAbi} from "@/lib/token/abis";

/// Live creator-fee state + claim transaction driver.
///
/// Reads `pendingClaim(token)` (returns wei accrued but not yet claimed) and
/// `eligible(token)` (whether the 72h Days-1–3 window is still active and the
/// token hasn't been filtered). Both refresh on a 15s tick — mid-window
/// accrual is what users come here to watch.
///
/// The `claim()` function fires a real wagmi `useWriteContract` and tracks
/// the receipt. After the tx confirms, the read cache is invalidated so
/// `pendingClaim` flips to zero without a manual refresh.

export type UseCreatorFeesResult = {
  /// Pending balance in wei. `0n` is a valid empty state.
  pending: bigint;
  /// Whether the 72-hour creator-fee window is still active. Once false, new
  /// trade fees redirect to treasury instead of accruing here.
  eligible: boolean;
  isLoading: boolean;
  error: Error | null;
  /// Submit a `claim(token)` tx. Resolves the moment the transaction is sent;
  /// observe `txHash`, `isMining`, `isMined` for completion.
  claim: () => void;
  txHash: `0x${string}` | undefined;
  isSubmitting: boolean;
  isMining: boolean;
  isMined: boolean;
  submitError: Error | null;
};

const DISTRIBUTOR_ADDRESS = deployment.addresses.creatorFeeDistributor as Address;

export function useCreatorFees(token: Address | null): UseCreatorFeesResult {
  const enabled = Boolean(token) && DISTRIBUTOR_ADDRESS !== zeroAddress;

  // Audit M-Perf-2 (Phase 1, 2026-05-03): explicit `staleTime: 15_000`
  // matching the refetchInterval. Default react-query staleTime is 0 — the
  // claim flow is on a creator-admin page that the user may tab away from
  // and back to. Without staleTime, every focus re-fetches both reads even
  // though the 15 s poll just pulled them; staleTime makes focus a no-op
  // when the cache is fresh. Arena-live hooks (`hooks/arena/*`) keep the
  // default 0 because realtime staleness is the contract there.
  const pending = useReadContract({
    address: DISTRIBUTOR_ADDRESS,
    abi: CreatorFeeDistributorAbi,
    functionName: "pendingClaim",
    args: token ? [token] : undefined,
    query: {enabled, refetchInterval: 15_000, staleTime: 15_000},
  });
  const eligible = useReadContract({
    address: DISTRIBUTOR_ADDRESS,
    abi: CreatorFeeDistributorAbi,
    functionName: "eligible",
    args: token ? [token] : undefined,
    query: {enabled, refetchInterval: 15_000, staleTime: 15_000},
  });

  const {writeContract, data: txHash, isPending: isSubmitting, error: submitError} = useWriteContract();
  const {isLoading: isMining, isSuccess: isMined} = useWaitForTransactionReceipt({hash: txHash});

  // After mining, refetch — claim() drains the balance, so the UI flips to
  // "claimed" without the user having to refresh the page. Do NOT reset the
  // wagmi write here: that clears `txHash`, which makes
  // `useWaitForTransactionReceipt` flip `isSuccess` back to false on the
  // very next render. Consumers branching on `isMined` (e.g.
  // ClaimFeesPanel's "Claim confirmed.") would see the message for a single
  // frame and lose it. The next `writeContract()` call resets state on its
  // own when the user claims again.
  useEffect(() => {
    if (isMined) {
      void pending.refetch();
    }
    // pending.refetch is stable; no other deps fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMined]);

  return {
    pending: (pending.data as bigint | undefined) ?? 0n,
    eligible: (eligible.data as boolean | undefined) ?? false,
    isLoading: enabled && (pending.isLoading || eligible.isLoading),
    error: pending.error ?? eligible.error ?? null,
    claim: () => {
      if (!token) return;
      writeContract({
        address: DISTRIBUTOR_ADDRESS,
        abi: CreatorFeeDistributorAbi,
        functionName: "claim",
        args: [token],
      });
    },
    txHash,
    isSubmitting,
    isMining,
    isMined,
    submitError: submitError ?? null,
  };
}
