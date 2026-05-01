"use client";

/// Slot-grid state for the /launch page.
///
/// Reads `getLaunchSlots(seasonId)` and `getLaunchStatus(seasonId)` from the
/// FilterLauncher contract, then merges with the indexer's `/tokens` cohort
/// (so each filled slot picks up its ticker / HP / status without a second
/// per-token RPC call).
///
/// Emits 12 always-stable rows: slot 0..11. Each row is one of:
///   - { kind: "filled" }    → token launched; ticker/hp/status from /tokens
///   - { kind: "filled-pending" } → on-chain but not yet indexed (race window)
///   - { kind: "next" }      → first empty slot; "Claim now"
///   - { kind: "almost" }    → empty + slot index >= 9; "Almost gone"
///   - { kind: "open" }      → empty + slot index < 9
///   - { kind: "closed" }    → window expired or cap reached, slot still empty
///
/// The grid renders 12 rows always — using `kind` to switch presentation —
/// so the visual rhythm of the page stays constant from launch open through
/// window close.

import {useMemo} from "react";
import {useReadContracts} from "wagmi";

import {contractAddresses, isDeployed} from "@/lib/addresses";
import {FilterLauncherLaunchAbi, MAX_LAUNCHES} from "@/lib/launch/abi";
import type {TokenResponse} from "@/lib/arena/api";

import {useLauncherSeason} from "./useLauncherSeason";

export type SlotKind =
  | "filled"
  | "filled-pending"
  | "next"
  | "almost"
  | "open"
  | "closed";

export type LaunchSlot = {
  slotIndex: number;
  kind: SlotKind;
  /// Set for filled / filled-pending kinds. Lower-cased addresses, matching
  /// the indexer cohort key.
  token?: `0x${string}`;
  creator?: `0x${string}`;
  /// Cost (wei, decimal string) to claim this slot if empty. `null` once
  /// the slot is filled or the window is closed — the UI uses this to drive
  /// the per-card cost label.
  costWei: bigint | null;
  /// Convenience join with the indexer's /tokens response. Undefined for
  /// `filled-pending` (on-chain but not yet indexed) and for empty slots.
  cohortEntry?: TokenResponse;
};

export type LaunchSlotsResult = {
  /// 12 slot rows in `slotIndex` order.
  slots: LaunchSlot[];
  /// Wire-direct status for the launch window (matches the contract's
  /// `LaunchStatus` struct).
  status: {
    launchCount: number;
    maxLaunches: number;
    timeRemainingSec: number;
    nextLaunchCostWei: bigint;
  } | null;
  isLoading: boolean;
  error: Error | null;
};

const ALMOST_GONE_FROM_SLOT = 9;

/// `cohort` should come from `useTokens()` — passing it in keeps this hook
/// stateless w.r.t. the indexer poll cadence (the page already polls /tokens
/// for the leaderboard; we don't want a second poll loop).
export function useLaunchSlots(cohort: TokenResponse[] | null): LaunchSlotsResult {
  const {data: seasonId} = useLauncherSeason();

  const enabled = isDeployed("filterLauncher") && seasonId !== null;
  const launcher = contractAddresses.filterLauncher;
  const sid = seasonId ?? 0n;

  const {data, isLoading, error} = useReadContracts({
    contracts: [
      {
        address: launcher,
        abi: FilterLauncherLaunchAbi,
        functionName: "getLaunchSlots",
        args: [sid],
      },
      {
        address: launcher,
        abi: FilterLauncherLaunchAbi,
        functionName: "getLaunchStatus",
        args: [sid],
      },
    ],
    query: {enabled, refetchInterval: 8_000},
  });

  return useMemo(() => {
    const status = parseStatus(data?.[1]?.result);
    const filledMap = parseFilledSlots(data?.[0]?.result);
    const slots = buildSlotRows({status, filledMap, cohort: cohort ?? []});
    return {
      slots,
      status,
      isLoading,
      error: error as Error | null,
    };
  }, [data, isLoading, error, cohort]);
}

function parseStatus(
  raw:
    | {launchCount: bigint; maxLaunches: bigint; timeRemaining: bigint; nextLaunchCost: bigint}
    | undefined,
): LaunchSlotsResult["status"] {
  if (!raw) return null;
  return {
    launchCount: Number(raw.launchCount),
    maxLaunches: Number(raw.maxLaunches),
    timeRemainingSec: Number(raw.timeRemaining),
    nextLaunchCostWei: raw.nextLaunchCost,
  };
}

function parseFilledSlots(
  raw: readonly [readonly `0x${string}`[], readonly bigint[], readonly `0x${string}`[]] | undefined,
): Map<number, {token: `0x${string}`; creator: `0x${string}`}> {
  const out = new Map<number, {token: `0x${string}`; creator: `0x${string}`}>();
  if (!raw) return out;
  const [tokens, slotIndexes, creators] = raw;
  for (let i = 0; i < tokens.length; i++) {
    const idx = Number(slotIndexes[i]);
    out.set(idx, {token: tokens[i]!, creator: creators[i]!});
  }
  return out;
}

/// Pure grid builder, exported for unit testing.
export function buildSlotRows({
  status,
  filledMap,
  cohort,
}: {
  status: LaunchSlotsResult["status"];
  filledMap: Map<number, {token: `0x${string}`; creator: `0x${string}`}>;
  cohort: TokenResponse[];
}): LaunchSlot[] {
  const cohortByAddress = new Map<string, TokenResponse>();
  for (const t of cohort) cohortByAddress.set(t.token.toLowerCase(), t);

  const launchCount = status?.launchCount ?? filledMap.size;
  const windowOpen = !status || (status.timeRemainingSec > 0 && status.launchCount < status.maxLaunches);
  const nextEmpty = launchCount; // Slot indices fill 0..N-1; next-to-claim is at index `launchCount`.

  const rows: LaunchSlot[] = [];
  for (let slotIndex = 0; slotIndex < MAX_LAUNCHES; slotIndex++) {
    const filled = filledMap.get(slotIndex);
    if (filled) {
      const cohortEntry = cohortByAddress.get(filled.token.toLowerCase());
      rows.push({
        slotIndex,
        kind: cohortEntry ? "filled" : "filled-pending",
        token: filled.token,
        creator: filled.creator,
        costWei: null,
        cohortEntry,
      });
      continue;
    }

    if (!windowOpen) {
      rows.push({slotIndex, kind: "closed", costWei: null});
      continue;
    }

    const cost = costForSlot(slotIndex, status?.nextLaunchCostWei, nextEmpty);
    if (slotIndex === nextEmpty) {
      rows.push({slotIndex, kind: "next", costWei: cost});
    } else if (slotIndex >= ALMOST_GONE_FROM_SLOT) {
      rows.push({slotIndex, kind: "almost", costWei: cost});
    } else {
      rows.push({slotIndex, kind: "open", costWei: cost});
    }
  }
  return rows;
}

/// Per-empty-slot cost preview. Mirrors `_launchCost(N) = BASE * (M^2 + N^2) / M^2`
/// using the contract's published `nextLaunchCost` (which is `_launchCost(launchCount)`)
/// to back-solve BASE without a second RPC call.
function costForSlot(
  slotIndex: number,
  nextCostWei: bigint | undefined,
  nextEmptyIndex: number,
): bigint | null {
  if (nextCostWei === undefined) return null;
  if (slotIndex === nextEmptyIndex) return nextCostWei;
  const m = BigInt(MAX_LAUNCHES);
  const n = BigInt(nextEmptyIndex);
  const s = BigInt(slotIndex);
  // nextCostWei = BASE * (m^2 + n^2) / m^2. Solve for `BASE * (m^2 + s^2) / m^2`.
  // To avoid losing precision, compute `cost = nextCostWei * (m^2 + s^2) / (m^2 + n^2)`.
  const num = nextCostWei * (m * m + s * s);
  const den = m * m + n * n;
  return num / den;
}
