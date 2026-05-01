"use client";

/// /launch — public launch page (Epic 1.5).
///
/// Composition:
///
///   ┌──────────────────────────────────────────────────────────────┐
///   │ ArenaTopBar (LIVE · Week · Next cut · Champion · Backing)    │
///   ├──────────────────────────────────────────────────────────────┤
///   │ LaunchHero (headline + summary + champion panel)             │
///   ├──────────────────────────────────────────────────────────────┤
///   │ FilterStrip (▼ THE FILTER · Top 6 survive · Bottom 6 cut)    │
///   ├──────────────────────────────────────┬───────────────────────┤
///   │ SlotGrid (12 cards)                  │ LaunchForm            │
///   │                                      │  + CostPanel          │
///   │                                      │  + Creator incentives │
///   └──────────────────────────────────────┴───────────────────────┘
///
/// Below 1100px: form moves below the slot grid; 4-col → 2-col grid.

import {useCallback, useMemo, useRef, useState} from "react";
import {useRouter} from "next/navigation";

import {ArenaTopBar} from "@/components/arena/ArenaTopBar";
import {Stars} from "@/components/broadcast/Stars";
import {LaunchHero} from "@/components/launch/LaunchHero";
import {FilterStrip} from "@/components/launch/FilterStrip";
import {SlotGrid} from "@/components/launch/SlotGrid";
import {LaunchForm} from "@/components/launch/LaunchForm";
import {useEligibility} from "@/hooks/launch/useEligibility";
import {useLaunchSlots} from "@/hooks/launch/useLaunchSlots";
import {useLaunchToken} from "@/hooks/launch/useLaunchToken";
import {useLauncherSeason} from "@/hooks/launch/useLauncherSeason";
import {useSeason} from "@/hooks/arena/useSeason";
import {useTickerEvents} from "@/hooks/arena/useTickerEvents";
import {useTokens} from "@/hooks/arena/useTokens";
import {useReadContract} from "wagmi";
import {contractAddresses, isDeployed} from "@/lib/addresses";
import {FilterLauncherLaunchAbi} from "@/lib/launch/abi";
import type {LaunchFormFields} from "@/lib/launch/validation";

export default function LaunchPage() {
  const router = useRouter();

  const {data: season} = useSeason();
  const {data: tokens} = useTokens();
  const {status: liveStatus} = useTickerEvents();

  const cohort = useMemo(() => tokens ?? [], [tokens]);
  const {slots, status} = useLaunchSlots(cohort);
  const eligibility = useEligibility();
  const {data: seasonId} = useLauncherSeason();
  const {phase, error: txError, launch, launchedToken} = useLaunchToken();

  // Local pin step — kept in the page (not the hook) so a hostile network
  // failure during pinning leaves the wallet untouched.
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);

  // Refundable-stake mode is a contract setting; we read it once so the
  // cost panel + total accurately reflect what `launchToken` will retain.
  const {data: stakeOn} = useReadContract({
    address: contractAddresses.filterLauncher,
    abi: FilterLauncherLaunchAbi,
    functionName: "refundableStakeEnabled",
    query: {enabled: isDeployed("filterLauncher")},
  });

  const formRef = useRef<HTMLDivElement | null>(null);
  const scrollToForm = useCallback(() => {
    formRef.current?.scrollIntoView({behavior: "smooth", block: "start"});
  }, []);

  // Slot the next launch will occupy.
  const nextSlotIndex = status?.launchCount ?? slots.findIndex((s) => s.kind === "next");
  const nextCostWei = status?.nextLaunchCostWei ?? 0n;
  const stakeWei = stakeOn ? nextCostWei : 0n;

  const onSubmit = useCallback(
    async (fields: LaunchFormFields) => {
      setPinError(null);
      setPinning(true);
      try {
        const res = await fetch("/api/metadata", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify(fields),
        });
        const json = (await res.json()) as {uri?: string; error?: string};
        if (!res.ok || !json.uri) {
          throw new Error(json.error ?? `Pin failed (${res.status})`);
        }
        setPinning(false);
        launch({
          name: fields.name.trim(),
          symbol: fields.ticker,
          metadataURI: json.uri,
          valueWei: nextCostWei + stakeWei,
        });
      } catch (e) {
        setPinError(e instanceof Error ? e.message : String(e));
        setPinning(false);
      }
    },
    [launch, nextCostWei, stakeWei],
  );

  // On success, redirect to /arena with the new token selected. The arena
  // page reads `?token=` and pre-selects the row.
  if (phase === "success" && launchedToken) {
    router.replace(`/arena?token=${launchedToken}`);
  }

  const reasonForBlock =
    eligibility.state === "eligible" ? undefined : eligibility.message;

  const phaseForButton = pinning ? "pinning" : phase;
  const combinedError = pinError ?? txError;

  return (
    <div style={{position: "relative", minHeight: "100vh", overflow: "hidden"}}>
      <Stars />
      <ArenaTopBar season={season} liveStatus={liveStatus} />

      <main className="ff-launch-page" style={{position: "relative", zIndex: 1}}>
        <LaunchHero season={season} slots={slots} status={status} onScrollToForm={scrollToForm} />

        <FilterStrip />

        <div className="ff-launch-body" ref={formRef}>
          <SlotGrid slots={slots} />
          <div style={{display: "flex", flexDirection: "column", gap: 14}}>
            {seasonId === null ? (
              <PlaceholderCard message="Connecting to launcher…" />
            ) : (
              <LaunchForm
                slotIndex={nextSlotIndex >= 0 ? nextSlotIndex : 0}
                launchCostWei={nextCostWei}
                stakeWei={stakeWei}
                cohort={cohort}
                disabledReason={reasonForBlock}
                phase={phaseForButton}
                error={combinedError}
                onSubmit={onSubmit}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function PlaceholderCard({message}: {message: string}) {
  return (
    <div
      style={{
        padding: 18,
        borderRadius: 14,
        border: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.03)",
        color: "rgba(255,235,255,0.62)",
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}
