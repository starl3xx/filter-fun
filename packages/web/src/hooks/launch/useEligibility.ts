"use client";

/// Eligibility branches for the /launch page (spec §4.6).
///
/// Possible outcomes:
///   - "loading"            → reads still pending (or contract not deployed)
///   - "not-connected"      → no wallet
///   - "already-launched"   → wallet has already used its launch this season
///   - "window-closed"      → launchCount === MAX or block.timestamp > end
///   - "eligible"           → form is rendered, launch button can fire
///
/// The page maps each branch to a piece of copy + form-visibility flag; the
/// hook itself stays UI-agnostic.

import {useMemo} from "react";
import {useAccount, useReadContracts} from "wagmi";

import {contractAddresses, isDeployed} from "@/lib/addresses";
import {FilterLauncherLaunchAbi} from "@/lib/launch/abi";

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

  const enabled = isDeployed("filterLauncher") && seasonId !== null && Boolean(address);
  const launcher = contractAddresses.filterLauncher;
  const sid = seasonId ?? 0n;

  const {data, isLoading} = useReadContracts({
    contracts: [
      {address: launcher, abi: FilterLauncherLaunchAbi, functionName: "canLaunch"},
      {
        address: launcher,
        abi: FilterLauncherLaunchAbi,
        functionName: "launchesByWallet",
        args: [sid, address ?? "0x0000000000000000000000000000000000000000"],
      },
      {
        address: launcher,
        abi: FilterLauncherLaunchAbi,
        functionName: "maxLaunchesPerWallet",
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

    const canLaunchOnchain = data[0]?.result === true;
    const used = (data[1]?.result as bigint | undefined) ?? 0n;
    const cap = (data[2]?.result as bigint | undefined) ?? 1n;

    if (used >= cap) {
      return {
        state: "already-launched",
        formVisible: false,
        message:
          "You've already launched a token this week — each wallet gets one shot per season. The next launch window opens Monday 00:00 UTC; come back then to launch again.",
        canSubmit: false,
      };
    }
    if (!canLaunchOnchain) {
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
