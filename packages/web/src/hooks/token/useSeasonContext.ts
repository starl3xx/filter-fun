"use client";

import type {Address} from "viem";
import {zeroAddress} from "viem";
import {useReadContract} from "wagmi";

import deployment from "@/lib/deployment.json";
import {FilterLauncherReadAbi} from "@/lib/token/abis";

/// Reads the current season ID and phase from FilterLauncher. The admin console
/// needs both to drive `useStakeStatus` (keyed on seasonId) and to gate
/// past-season tokens (which hide live panels). Polls on a 30s tick — phase
/// changes are rare and the scheduler advances them deterministically at the
/// hour anchors (96 / 168) so high-frequency polling is wasted RPC.
///
/// Audit M-Perf-2 (Phase 1, 2026-05-03): explicit `staleTime: 30_000` on each
/// query. Default react-query staleTime is 0 — without this, every window-
/// focus / mount / reconnect event re-fetches even when the 30 s poll just
/// pulled the same data. Matching staleTime to refetchInterval makes
/// focus events a no-op when the cache is fresh. Arena-live hooks
/// (`hooks/arena/*`) intentionally keep the default 0 because real-time
/// staleness is the contract there.

export type SeasonContext = {
  seasonId: bigint | null;
  /// 0=Launch, 1=Filter, 2=Finals, 3=Settlement, 4=Closed.
  phase: number | null;
};

const LAUNCHER_ADDRESS = deployment.addresses.filterLauncher as Address;

export function useSeasonContext(): {context: SeasonContext; isLoading: boolean} {
  const enabled = LAUNCHER_ADDRESS !== zeroAddress;

  const seasonId = useReadContract({
    address: LAUNCHER_ADDRESS,
    abi: FilterLauncherReadAbi,
    functionName: "currentSeasonId",
    query: {enabled, refetchInterval: 30_000, staleTime: 30_000},
  });

  const sid = seasonId.data as bigint | undefined;

  const phase = useReadContract({
    address: LAUNCHER_ADDRESS,
    abi: FilterLauncherReadAbi,
    functionName: "phaseOf",
    args: sid !== undefined ? [sid] : undefined,
    query: {enabled: enabled && sid !== undefined, refetchInterval: 30_000, staleTime: 30_000},
  });

  return {
    context: {
      seasonId: sid ?? null,
      phase: (phase.data as number | undefined) ?? null,
    },
    isLoading: enabled && (seasonId.isLoading || phase.isLoading),
  };
}
