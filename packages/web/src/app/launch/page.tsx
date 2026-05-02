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
///   │ SlotGrid (12 cards)                  │ LaunchForm OR notice  │
///   │                                      │  + CostPanel          │
///   │                                      │  + Creator incentives │
///   └──────────────────────────────────────┴───────────────────────┘
///
/// Below 1100px: form moves below the slot grid; 4-col → 2-col grid.

import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {useRouter} from "next/navigation";

import {ArenaTopBar} from "@/components/arena/ArenaTopBar";
import {DataErrorBanner} from "@/components/DataErrorBanner";
import {Stars} from "@/components/Stars";
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
import {FilterLauncherLaunchAbi, MAX_LAUNCHES} from "@/lib/launch/abi";
import {canonicalSymbol, type LaunchFormFields} from "@/lib/launch/validation";
import {C, F} from "@/lib/tokens";

export default function LaunchPage() {
  const router = useRouter();

  const {data: season, error: seasonError} = useSeason();
  const {data: tokens, error: tokensError} = useTokens();
  const {status: liveStatus} = useTickerEvents();
  // Phase 1 audit C-5 (2026-05-01): surface fetch errors instead of dropping
  // them silently. The launch page can still render the slot grid + form on
  // stale data, so the banner is a non-blocking informational chip.
  const dataError = tokensError ?? seasonError ?? null;

  const cohort = useMemo(() => tokens ?? [], [tokens]);
  const {slots, status} = useLaunchSlots(cohort);
  const eligibility = useEligibility();
  const {data: seasonId} = useLauncherSeason();
  const {phase, error: txError, launch, launchedToken, reset: resetLaunch} = useLaunchToken();

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

  // Slot the next launch will occupy. Clamp to [0, MAX_LAUNCHES-1] — when
  // launchCount === MAX_LAUNCHES the eligibility branch already hides the
  // form (window-closed), but the display path still renders briefly while
  // the eligibility read settles. Without clamping, "Slot #13" can flash.
  // `findIndex` returns -1 when no "next" slot exists (all filled / closed);
  // fall back to the last slot rather than letting Math.max clamp to 0,
  // which would mislabel as "Slot #01" instead of the actually-final state.
  const findNextIdx = slots.findIndex((s) => s.kind === "next");
  const rawNext = status?.launchCount ?? (findNextIdx >= 0 ? findNextIdx : MAX_LAUNCHES - 1);
  const nextSlotIndex = Math.min(Math.max(rawNext, 0), MAX_LAUNCHES - 1);
  const nextCostWei = status?.nextLaunchCostWei ?? 0n;
  // `stakeOn` is `boolean | undefined`; `undefined` means the
  // `refundableStakeEnabled` read hasn't resolved yet. We capture both the
  // resolved stake value AND the loaded-or-not signal in costRef so onSubmit
  // can refuse to send an under-payment during the loading window.
  const stakeReady = stakeOn !== undefined;
  const stakeWei = stakeOn ? nextCostWei : 0n;

  // Keep the live cost in a ref so the async `onSubmit` reads the LATEST
  // value at write-contract time rather than whatever was current when the
  // callback was first bound. Without this, a slot claim that lands during
  // our pin step (which can take seconds against IPFS) leaves the closure
  // sending a stale `nextCostWei`, which the contract rejects with
  // `InsufficientPayment`. Refs update synchronously on every render so the
  // closure's read is the freshest value the page has seen.
  const costRef = useRef({nextCostWei, stakeWei, stakeReady});
  costRef.current = {nextCostWei, stakeWei, stakeReady};

  const onSubmit = useCallback(
    async (fields: LaunchFormFields) => {
      // Clear BOTH error sources at the start of every submit so a retry
      // doesn't render the previous attempt's tx error (e.g. "user rejected
      // transaction") underneath the "Pinning metadata…" button state.
      // `useLaunchToken.reset()` resets phase + clears `txError` + resets
      // the underlying wagmi `useWriteContract` state.
      setPinError(null);
      resetLaunch();
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
        // Read the latest cost AT submit time — see costRef commentary above.
        const {nextCostWei: liveCost, stakeWei: liveStake, stakeReady: liveStakeReady} = costRef.current;
        // Belt-and-suspenders for a narrow loading window: `useEligibility`,
        // `getLaunchStatus`, and `refundableStakeEnabled` are separate wagmi
        // reads. Eligibility can resolve to "eligible" (form rendered) one
        // beat before the cost or stake-mode reads land. A submit in that
        // window would send `liveCost + 0n` instead of `liveCost + liveCost`
        // (when stake is enabled) — under-payment, contract reverts with
        // `InsufficientPayment`. Refuse upfront with a clear message.
        if (liveCost === 0n || !liveStakeReady) {
          setPinError("Launch settings are still loading from the contract. Try again in a moment.");
          return;
        }
        // Belt-and-suspenders: the form already canonicalizes the ticker
        // before calling onSubmit, but re-canonicalize here so the contract
        // can never receive a non-canonical symbol regardless of how this
        // function is called. The contract uses keccak256(bytes(symbol))
        // as its uniqueness key, so a single divergent character would
        // produce a different hash than the form's collision check used.
        launch({
          name: fields.name.trim(),
          symbol: canonicalSymbol(fields.ticker),
          metadataURI: json.uri,
          valueWei: liveCost + liveStake,
        });
      } catch (e) {
        setPinError(e instanceof Error ? e.message : String(e));
        setPinning(false);
      }
    },
    // Cost values are NOT in deps — they're read via ref. `launch` is the
    // only value the closure pulls from the outer scope.
    [launch, resetLaunch],
  );

  // On success, redirect to the homepage (the arena IS the homepage as of
  // PR #39 follow-up) with the new token selected. Run inside an effect so
  // navigation is a side effect, not a render-phase action — the latter
  // double-fires under React Strict Mode and breaks the React rules.
  useEffect(() => {
    if (phase === "success" && launchedToken) {
      router.replace(`/?token=${launchedToken}`);
    }
  }, [phase, launchedToken, router]);

  const phaseForButton = pinning ? "pinning" : phase;
  const combinedError = pinError ?? txError;

  return (
    <div style={{position: "relative", minHeight: "100vh", overflow: "hidden"}}>
      <Stars />
      <ArenaTopBar season={season} liveStatus={liveStatus} />
      {dataError && <DataErrorBanner error={dataError} />}

      <main className="ff-launch-page" style={{position: "relative", zIndex: 1}}>
        <LaunchHero season={season} slots={slots} status={status} onScrollToForm={scrollToForm} />

        <FilterStrip />

        <div className="ff-launch-body" ref={formRef}>
          <SlotGrid slots={slots} />
          <div style={{display: "flex", flexDirection: "column", gap: 14}}>
            {seasonId === null ? (
              <NoticeCard tone="info" title="Connecting to launcher…" body="Reading current season state from the contract." />
            ) : eligibility.formVisible ? (
              <LaunchForm
                slotIndex={nextSlotIndex}
                launchCostWei={nextCostWei}
                stakeWei={stakeWei}
                cohort={cohort}
                phase={phaseForButton}
                error={combinedError}
                onSubmit={onSubmit}
              />
            ) : (
              <NoticeCard
                tone={eligibility.state === "loading" ? "info" : "warn"}
                title={titleFor(eligibility.state)}
                body={eligibility.message}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

type EligibilityNoticeState = ReturnType<typeof useEligibility>["state"];

function titleFor(state: EligibilityNoticeState): string {
  switch (state) {
    case "not-connected":
      return "Connect to launch";
    case "already-launched":
      return "You've already launched this week";
    case "window-closed":
      return "Launch window closed";
    case "loading":
      return "Checking eligibility…";
    default:
      return "Launch unavailable";
  }
}

function NoticeCard({tone, title, body}: {tone: "info" | "warn"; title: string; body: string}) {
  const accent = tone === "warn" ? C.red : C.cyan;
  return (
    <section
      aria-live="polite"
      style={{
        padding: 18,
        borderRadius: 14,
        border: `1px solid ${accent}55`,
        background: `${accent}0d`,
        color: C.text,
      }}
    >
      <div
        style={{
          fontFamily: F.mono,
          fontSize: 10,
          letterSpacing: "0.16em",
          fontWeight: 800,
          color: accent,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <p style={{margin: 0, fontSize: 13, color: C.dim, lineHeight: 1.5}}>{body}</p>
    </section>
  );
}
