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
/// The write path is `FilterLauncher.reserve(ticker, metadataURI)` (spec
/// §46.9) — Epic 1.15a replaced the never-shipped `launchToken(name, symbol,
/// metadataURI)` with the reservation entry point. The canonical on-chain
/// symbol IS the ticker; the display name lives only in the pinned metadata.
///
/// On success, the page reads the parsed `TokenLaunched` event from the
/// receipt to derive the new token's address and redirects to
/// `/arena?token=0x…`. Pre-activation (slots 1–3) the reservation is QUEUED —
/// no `TokenLaunched` fires in the reserve tx — so `launchedToken` stays null
/// and the page falls back to a plain arena redirect; the slot grid picks the
/// reservation up via the indexer's launch-status overlay (Epic 1.15c).

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
  /// Canonical ticker (post-`canonicalSymbol`): 2–10 chars, A–Z / 0–9. The
  /// contract re-normalizes via TickerLib and uses the result as the on-chain
  /// token symbol, so the display `name` is metadata-only and never sent here.
  ticker: string;
  /// Pre-pinned URI (ipfs:// or https://) — produced by /api/metadata.
  metadataURI: string;
  /// Total to send (cost + stake). The contract expects ≥ the slot cost; the
  /// stake is held when `refundableStakeEnabled` is true. The page sums
  /// both before calling. `0n` is unambiguous Filter Club intent (spec
  /// §47.3.8): the contract consults the pass exactly when `msg.value == 0`,
  /// so a credit launch sends zero rather than an underpayment.
  valueWei: bigint;
};

export type UseLaunchTokenResult = {
  phase: LaunchPhase;
  txHash: Hash | null;
  /// Parsed `TokenLaunched` event payload — populated on success when the
  /// reserve tx deployed in-line (post-activation). Null for queued
  /// pre-activation reservations, which emit no `TokenLaunched`.
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
          functionName: "reserve",
          args: [payload.ticker, payload.metadataURI],
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
  // page can deep-link the new token in /arena. Absent event (queued
  // pre-activation reservation) is still a success — launchedToken stays null.
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

/// Map `reserve()`'s custom-error surface (spec §46.9 — one error per
/// validation gate, mirrored in `FilterLauncherLaunchAbi`) to user copy.
/// viem surfaces the decoded error NAME in the message; each branch tells
/// the user what happened AND what to do next (Audit M-Ux-5 posture).
function humanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/WrongPhase/.test(msg)) return "The launch window isn't open right now — this season has moved past its launch phase.";
  if (/SeasonAlreadyAborted/.test(msg)) return "This season was aborted — no new reservations. A fresh season opens Monday 00:00 UTC.";
  if (/WindowClosed/.test(msg)) return "Launch window closed before your transaction mined.";
  if (/AlreadyReserved/.test(msg)) return "This wallet already holds a slot this season — one reservation per wallet.";
  if (/SlotsExhausted/.test(msg)) return "All 12 slots are taken — someone beat you to the last one.";
  if (/InvalidTickerFormat/.test(msg)) return "Ticker must be 2–10 characters, A–Z and 0–9 only.";
  if (/TickerBlocklisted/.test(msg)) return "That ticker is protocol-blocklisted. Pick another.";
  if (/TickerWinnerReserved/.test(msg)) return "That ticker belongs to a past weekly winner — reserved across seasons. Pick another.";
  if (/TickerTaken/.test(msg)) return "Ticker collided with another launch this season.";
  if (/InsufficientEscrow/.test(msg)) return "Not enough ETH attached for this slot — or your Filter Club credit couldn't be applied.";
  if (/RefundFailed/.test(msg)) return "Refunding your excess ETH failed, so the whole transaction was rolled back. Try again.";
  if (/User rejected/.test(msg)) return "You rejected the transaction.";
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}
