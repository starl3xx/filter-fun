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

  return useMemo<UseEligibilityResult>(() => {
    if (!isConnected) {
      return {
        state: "not-connected",
        formVisible: false,
        message: "Connect a wallet to launch.",
        canSubmit: false,
      };
    }
    if (!isDeployed("filterLauncher")) {
      return {
        state: "loading",
        formVisible: false,
        message: "Launcher not deployed in this environment.",
        canSubmit: false,
      };
    }
    if (isLoading || !data) {
      return {state: "loading", formVisible: false, message: "Checking eligibility…", canSubmit: false};
    }

    const canLaunchOnchain = data[0]?.result === true;
    const used = (data[1]?.result as bigint | undefined) ?? 0n;
    const cap = (data[2]?.result as bigint | undefined) ?? 1n;

    if (used >= cap) {
      return {
        state: "already-launched",
        formVisible: false,
        message: "You've already launched a token this week. Each wallet gets one shot per season.",
        canSubmit: false,
      };
    }
    if (!canLaunchOnchain) {
      return {
        state: "window-closed",
        formVisible: false,
        message: "Launch window is closed. The next season opens Monday 00:00 UTC.",
        canSubmit: false,
      };
    }
    return {state: "eligible", formVisible: true, message: "", canSubmit: true};
  }, [isConnected, isLoading, data]);
}
