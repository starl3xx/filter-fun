"use client";

/// Mint transaction flow for /club (Epic 2.6 / spec §47.3.8). Mirrors the
/// useLaunchToken phase machine minus the pin step — the pass has no
/// metadata to pin, so the pipeline is sign → broadcast → receipt.
///
/// Phases (`phase` field):
///   - "idle"        → no submit yet
///   - "signing"     → wallet popup open; user has not yet signed
///   - "broadcasting"→ tx hash returned, waiting on receipt
///   - "success"     → mined; `mintedTokenIds` carries the receipt-parsed ids
///   - "error"       → user-facing error in `error` field
///
/// On success the page renders "Pass #12 minted" from the `Minted` logs —
/// one event per pass, so a qty-3 mint yields three ids.

import {useCallback, useEffect, useState} from "react";
import {decodeEventLog, type Address, type Hash, type Hex} from "viem";
import {usePublicClient, useWriteContract} from "wagmi";

import {contractAddresses, isDeployed} from "@/lib/addresses";
import {FilterClubPassAbi} from "@/lib/club/abi";

export type MintPhase = "idle" | "signing" | "broadcasting" | "success" | "error";

export type MintPayload = {
  qty: bigint;
  /// Exact total (`mintPrice × qty`). The contract requires exact payment
  /// (`WrongPayment` on any dust either direction), so the page computes
  /// this from the on-chain `mintPrice` read — never a hardcoded price.
  valueWei: bigint;
};

export type UseMintPassResult = {
  phase: MintPhase;
  txHash: Hash | null;
  /// Token ids parsed from the receipt's `Minted` logs — populated on
  /// success, ascending mint order.
  mintedTokenIds: bigint[];
  error: string | null;
  mint: (payload: MintPayload) => void;
  reset: () => void;
};

export function useMintPass(): UseMintPassResult {
  const [phase, setPhase] = useState<MintPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [mintedTokenIds, setMintedTokenIds] = useState<bigint[]>([]);

  const publicClient = usePublicClient();
  const {writeContract, data: txHash, reset: resetWrite} = useWriteContract();

  const mint = useCallback(
    (payload: MintPayload) => {
      if (!isDeployed("filterClubPass")) {
        setError("Filter Club pass not deployed.");
        setPhase("error");
        return;
      }
      setError(null);
      setMintedTokenIds([]);
      setPhase("signing");
      writeContract(
        {
          address: contractAddresses.filterClubPass,
          abi: FilterClubPassAbi,
          functionName: "mint",
          args: [payload.qty],
          value: payload.valueWei,
        },
        {
          onSuccess: () => setPhase("broadcasting"),
          onError: (err) => {
            setError(humanError(err));
            setPhase("error");
          },
        },
      );
    },
    [writeContract],
  );

  // Watch the receipt; when it lands, decode every Minted event so the page
  // can announce the exact pass numbers.
  useEffect(() => {
    if (!txHash || !publicClient) return;
    let cancelled = false;
    void (async () => {
      try {
        const receipt = await publicClient.waitForTransactionReceipt({hash: txHash});
        if (cancelled) return;
        if (receipt.status !== "success") {
          setError("Transaction reverted on-chain.");
          setPhase("error");
          return;
        }
        setMintedTokenIds(parseMintedIdsFromReceipt(receipt.logs));
        setPhase("success");
      } catch (err) {
        if (cancelled) return;
        setError(humanError(err));
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [txHash, publicClient]);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
    setMintedTokenIds([]);
    resetWrite();
  }, [resetWrite]);

  return {phase, txHash: txHash ?? null, mintedTokenIds, error, mint, reset};
}

/// Exported for the receipt-parse unit test — pure log walk, no hooks.
export function parseMintedIdsFromReceipt(
  logs: ReadonlyArray<{address: Address; topics: ReadonlyArray<Hex>; data: Hex}>,
): bigint[] {
  const pass = contractAddresses.filterClubPass.toLowerCase();
  const ids: bigint[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== pass) continue;
    try {
      const decoded = decodeEventLog({
        abi: FilterClubPassAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName === "Minted") {
        ids.push(decoded.args.tokenId as bigint);
      }
    } catch {
      // Not a Minted log (e.g. the ERC-721 Transfer) — ignore and continue.
    }
  }
  return ids;
}

/// Map `mint()`'s custom-error surface (mirrored in `FilterClubPassAbi`) to
/// user copy — same what-happened + what-next posture as
/// `useLaunchToken.humanError`.
function humanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/SoldOut/.test(msg)) return "Sold out — the last pass went before your transaction mined.";
  if (/WrongPayment/.test(msg)) return "Payment must be exactly price × quantity — refresh and try again.";
  if (/InvalidQuantity/.test(msg)) return "Quantity must be at least 1.";
  if (/WalletCapExceeded/.test(msg)) return "That quantity would exceed your wallet's lifetime mint cap.";
  if (/PayoutFailed/.test(msg)) return "Proceeds payout failed on-chain, so the mint was rolled back. Try again.";
  if (/User rejected/.test(msg)) return "You rejected the transaction.";
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}
