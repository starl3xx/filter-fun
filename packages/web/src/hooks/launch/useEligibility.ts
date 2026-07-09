"use client";

/// Eligibility branches for the /launch page (spec §4.6).
///
/// Possible outcomes:
///   - "loading"            → reads still pending (or contract not deployed)
///   - "not-connected"      → no wallet
///   - "already-launched"   → wallet already holds this season's reservation
///   - "window-closed"      → phase/pause/abort/expiry/cap — lens `canReserve` is false
///   - "eligible"           → form is rendered, launch button can fire
///
/// The page maps each branch to a piece of copy + form-visibility flag; the
/// hook itself stays UI-agnostic.
///
/// Epic 1.15a drift fix: the old reads (`canLaunch` / `launchesByWallet` /
/// `maxLaunchesPerWallet`) no longer exist on any contract. Spec §46 made the
/// per-wallet cap STRUCTURAL — one reservation per wallet per season, recorded
/// in `LaunchEscrow` — so "already launched" is now `reservedAtOf(sid, wallet)
/// != 0` on the escrow, and the window gate is the lens's `canReserve()`
/// (which folds pause + phase + abort + expiry + slots-full into one read).
/// Both companion addresses resolve off the launcher at runtime (immutables;
/// wagmi caches the reads).

import {useMemo} from "react";
import {useAccount, useReadContract, useReadContracts} from "wagmi";

import {contractAddresses, isDeployed} from "@/lib/addresses";
import {
  FilterLauncherEscrowGetterAbi,
  LaunchEscrowAbi,
  LauncherLensAbi,
} from "@/lib/launch/abi";

import {useLauncherLens} from "./useLauncherLens";
import {useLauncherSeason} from "./useLauncherSeason";

export type EligibilityState =
  | "loading"
  | "not-connected"
  | "already-launched"
  | "window-closed"
  | "eligible";

export type UseEligibilityResult = {
  state: EligibilityState;
  /// True iff the launch form should render. False for every state except
  /// "eligible".
  formVisible: boolean;
  /// User-facing message keyed off `state`. Empty string when `eligible`
  /// (the form replaces the message in that branch).
  message: string;
  /// Convenience flag wired into the launch button's `disabled` attribute.
  canSubmit: boolean;
};

export function useEligibility(): UseEligibilityResult {
  const {address, isConnected} = useAccount();
  const {data: seasonId} = useLauncherSeason();
  const {lensAddress} = useLauncherLens();

  // Escrow address off the launcher — same pattern as useClaimRefund.
  const {data: escrowAddress} = useReadContract({
    address: contractAddresses.filterLauncher,
    abi: FilterLauncherEscrowGetterAbi,
    functionName: "launchEscrow",
    query: {enabled: isDeployed("filterLauncher"), staleTime: Infinity},
  });

  const enabled =
    isDeployed("filterLauncher") &&
    seasonId !== null &&
    Boolean(address) &&
    Boolean(lensAddress) &&
    Boolean(escrowAddress);
  const sid = seasonId ?? 0n;

  const {data, isLoading} = useReadContracts({
    contracts: [
      {address: lensAddress, abi: LauncherLensAbi, functionName: "canReserve"},
      {
        address: escrowAddress as `0x${string}` | undefined,
        abi: LaunchEscrowAbi,
        functionName: "reservedAtOf",
        args: [sid, address ?? "0x0000000000000000000000000000000000000000"],
      },
    ],
    query: {enabled, refetchInterval: 8_000},
  });

  // Audit M-Ux-5 (Phase 1, 2026-05-03): every non-eligible branch must
  // tell the user what to DO next, not just what state they're in.
  // Pre-fix the copy was technically correct but two of the messages
  // ("Connect a wallet to launch.", "Launcher not deployed in this
  // environment.") gave the user no actionable next step. Each branch
  // below now ends with a concrete instruction or a re-entry time so
  // the NoticeCard renders as a clear next action, not a dead-end
  // status.
  return useMemo<UseEligibilityResult>(() => {
    if (!isConnected) {
      return {
        state: "not-connected",
        formVisible: false,
        message:
          "Use the Connect Wallet button in the top bar to choose a wallet — once connected, the launch form unlocks here.",
        canSubmit: false,
      };
    }
    if (!isDeployed("filterLauncher")) {
      return {
        state: "loading",
        formVisible: false,
        message:
          "The launcher contract is not deployed in this environment. Switch to the production network (top-right network selector) to launch a token.",
        canSubmit: false,
      };
    }
    if (isLoading || !data) {
      return {
        state: "loading",
        formVisible: false,
        message:
          "Reading your wallet's launch status from the launcher contract — this usually takes 1–2 seconds.",
        canSubmit: false,
      };
    }

    const canReserveOnchain = data[0]?.result === true;
    // Spec §46: existence sentinel is `reservedAt != 0` — mirrors the escrow's
    // own check, so a zero-cost (Filter Club credit) reservation counts too.
    const reservedAt = (data[1]?.result as bigint | number | undefined) ?? 0;

    if (BigInt(reservedAt) !== 0n) {
      return {
        state: "already-launched",
        formVisible: false,
        message:
          "You've already reserved a launch slot this week — each wallet gets one shot per season. The next launch window opens Monday 00:00 UTC; come back then to launch again.",
        canSubmit: false,
      };
    }
    if (!canReserveOnchain) {
      return {
        state: "window-closed",
        formVisible: false,
        message:
          "The launch window for this week's cohort is closed. New launches reopen Monday 00:00 UTC. In the meantime, head back to the arena to watch this week's tokens compete.",
        canSubmit: false,
      };
    }
    return {state: "eligible", formVisible: true, message: "", canSubmit: true};
  }, [isConnected, isLoading, data]);
}
