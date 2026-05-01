"use client";

/// Launch transaction flow for /launch.
///
/// Phases (`phase` field):
///   - "idle"        → no submit yet
///   - "pinning"     → POST /api/metadata in flight
///   - "signing"     → wallet popup open; user has not yet signed
///   - "broadcasting"→ tx hash returned, waiting on receipt
///   - "success"     → mined; the page redirects to /arena
///   - "error"       → user-facing error in `error` field
///
/// On success, the page reads the parsed `TokenLaunched` event from the
/// receipt to derive the new token's address and redirects to
/// `/arena?token=0x…`.

import {useCallback, useEffect, useState} from "react";
import {decodeEventLog, type Address, type Hash, type Hex} from "viem";
import {usePublicClient, useWriteContract} from "wagmi";

import {contractAddresses, isDeployed} from "@/lib/addresses";
import {FilterLauncherLaunchAbi} from "@/lib/launch/abi";

export type LaunchPhase =
  | "idle"
  | "pinning"
  | "signing"
  | "broadcasting"
  | "success"
  | "error";

export type LaunchPayload = {
  name: string;
  symbol: string;
  /// Pre-pinned URI (ipfs:// or https://) — produced by /api/metadata.
  metadataURI: string;
  /// Total to send (cost + stake). The contract expects ≥ launchCost; the
  /// stake is held when `refundableStakeEnabled` is true. The page sums
  /// both before calling.
  valueWei: bigint;
};

export type UseLaunchTokenResult = {
  phase: LaunchPhase;
  txHash: Hash | null;
  /// Parsed `TokenLaunched` event payload — populated on success.
  launchedToken: Address | null;
  error: string | null;
  /// Submits the launch — pin then write. The page is responsible for the
  /// pin step (so the form can be in scope), but exposes its result via
  /// `setPhase("pinning")` ahead of calling this.
  launch: (payload: LaunchPayload) => void;
  reset: () => void;
};

export function useLaunchToken(): UseLaunchTokenResult {
  const [phase, setPhase] = useState<LaunchPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [launchedToken, setLaunchedToken] = useState<Address | null>(null);

  const publicClient = usePublicClient();
  const {writeContract, data: txHash, reset: resetWrite} = useWriteContract();

  const launch = useCallback(
    (payload: LaunchPayload) => {
      if (!isDeployed("filterLauncher")) {
        setError("Launcher not deployed.");
        setPhase("error");
        return;
      }
      setError(null);
      setLaunchedToken(null);
      setPhase("signing");
      writeContract(
        {
          address: contractAddresses.filterLauncher,
          abi: FilterLauncherLaunchAbi,
          functionName: "launchToken",
          args: [payload.name, payload.symbol, payload.metadataURI],
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

  // Watch the receipt; when it lands, decode the TokenLaunched event so the
  // page can deep-link the new token in /arena.
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
        const token = parseLaunchedTokenFromReceipt(receipt.logs);
        if (token) setLaunchedToken(token);
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
    setLaunchedToken(null);
    resetWrite();
  }, [resetWrite]);

  return {phase, txHash: txHash ?? null, launchedToken, error, launch, reset};
}

function parseLaunchedTokenFromReceipt(
  logs: ReadonlyArray<{address: Address; topics: ReadonlyArray<Hex>; data: Hex}>,
): Address | null {
  const launcher = contractAddresses.filterLauncher.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== launcher) continue;
    try {
      const decoded = decodeEventLog({
        abi: FilterLauncherLaunchAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName === "TokenLaunched") {
        return decoded.args.token as Address;
      }
    } catch {
      // Not a TokenLaunched log — ignore and continue.
    }
  }
  return null;
}

function humanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // viem surfaces the revert reason in the message; trim the long stack.
  if (/InsufficientPayment/.test(msg)) return "Not enough ETH for slot cost + stake.";
  if (/LaunchCapReached/.test(msg)) return "Slot already taken — someone beat you to it.";
  if (/LaunchWindowClosed/.test(msg)) return "Launch window closed before tx mined.";
  if (/DuplicateSymbol/.test(msg)) return "Ticker collided with another launch this season.";
  if (/User rejected/.test(msg)) return "You rejected the transaction.";
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}
