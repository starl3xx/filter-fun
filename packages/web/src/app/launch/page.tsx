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
import {PendingRefundBanner} from "@/components/launch/PendingRefundBanner";
import {RoiCalculator} from "@/components/launch/RoiCalculator";
import {useClubCredits} from "@/hooks/launch/useClubCredits";
import {useEligibility} from "@/hooks/launch/useEligibility";
import {useLaunchSlots} from "@/hooks/launch/useLaunchSlots";
import {useLaunchToken} from "@/hooks/launch/useLaunchToken";
import {useLauncherSeason} from "@/hooks/launch/useLauncherSeason";
import {useSeason} from "@/hooks/arena/useSeason";
import {useTickerEvents} from "@/hooks/arena/useTickerEvents";
import {useTokens} from "@/hooks/arena/useTokens";
import {formatEther} from "viem";
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

  // Epic 2.6 — Filter Club credit. The toggle defaults OFF (spending a
  // lifetime credit must be explicit) and only arms when the wallet actually
  // holds credit; `creditApplied` is the effective flag the tx path reads,
  // so a credit consumed elsewhere mid-session (8s poll catches it) silently
  // disarms the toggle rather than sending a doomed `value: 0n` reserve.
  const {totalCredits, hasCredit} = useClubCredits();
  const [useCredit, setUseCredit] = useState(false);
  const creditApplied = useCredit && hasCredit;

  // Refundable-stake mode is a contract setting; we read it once so the
  // cost panel + total accurately reflect what `reserve` will retain.
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
  // `refundableStakeEnabled` read hasn't resolved yet. Captured in
  // `submitSnapshot` (below) so onSubmit can refuse to send an under-payment
  // during the loading window.
  const stakeReady = stakeOn !== undefined;
  const stakeWei = stakeOn ? nextCostWei : 0n;

  // Audit H-Web-2 (Phase 1, 2026-05-01): snapshot the slot+cost+stake at
  // submit time and pass the snapshotted value into the launch tx — NOT a
  // live ref. The pre-fix `costRef` pattern read whatever the latest cost
  // was at write-contract time, which silently re-priced the user's launch
  // when a slot tier rollover happened during the pin step (~seconds against
  // IPFS). Snapshotting locks the user's commitment to the values they saw
  // when they clicked. If a tier rollover beats the tx, the contract reverts
  // with `InsufficientEscrow` (mapped to a friendly message in
  // `useLaunchToken.humanError`) and the user re-confirms with the new cost.
  //
  // Follow-up for Epic 1.15: `reserve(ticker, metadataURI)` still doesn't
  // take a slot index arg — it assigns the next available slot internally. A
  // slot-pinned variant with `error SlotTaken(uint8)` would let us
  // distinguish "slot taken" from "tier rolled over" — both fail with
  // `InsufficientEscrow` today which is misleading on the former.
  //
  // `creditApplied` rides in the snapshot too (Epic 2.6): the badge must
  // keep saying "Filter Club credit" for the whole pin → sign → broadcast
  // pipeline even if the toggle disarms mid-flight (credit consumed in
  // another tab) — the tx the user signed is the snapshotted one.
  type LaunchSnapshot = {
    slotIndex: number;
    nextCostWei: bigint;
    stakeWei: bigint;
    creditApplied: boolean;
  };
  const [snapshot, setSnapshot] = useState<LaunchSnapshot | null>(null);

  const onSubmit = useCallback(
    async (fields: LaunchFormFields) => {
      // Clear BOTH error sources at the start of every submit so a retry
      // doesn't render the previous attempt's tx error (e.g. "user rejected
      // transaction") underneath the "Pinning metadata…" button state.
      // `useLaunchToken.reset()` resets phase + clears `txError` + resets
      // the underlying wagmi `useWriteContract` state.
      setPinError(null);
      resetLaunch();
      // Belt-and-suspenders for a narrow loading window: `useEligibility`,
      // `getLaunchStatus`, and `refundableStakeEnabled` are separate wagmi
      // reads. Eligibility can resolve to "eligible" (form rendered) one
      // beat before the cost or stake-mode reads land. A submit in that
      // window would send an ACCIDENTAL `0n` to the contract — which since
      // Epic 2.6 is unambiguous Filter Club intent (`InsufficientEscrow`
      // revert for non-holders, or worse: a silently burned credit for a
      // holder who meant to pay). Refuse upfront with a clear message. The
      // guard applies on the credit path too — a deliberate free launch
      // still waits for the reads so the struck-through cost the user
      // acknowledged is the real one, not a loading dash.
      if (nextCostWei === 0n || !stakeReady) {
        setPinError("Launch settings are still loading from the contract. Try again in a moment.");
        return;
      }
      // Snapshot the commitment AT submit click — this is the binding contract
      // between the user and the price they saw. Cleared by `resetLaunch()` in
      // a follow-up render-cycle? No: kept until next submit so the status
      // badge can render the snapshotted slot+cost during pinning + signing +
      // broadcasting.
      const snap: LaunchSnapshot = {
        slotIndex: nextSlotIndex,
        nextCostWei,
        stakeWei,
        creditApplied,
      };
      setSnapshot(snap);
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
        // Belt-and-suspenders: the form already canonicalizes the ticker
        // before calling onSubmit, but re-canonicalize here so the contract
        // can never receive a non-canonical ticker regardless of how this
        // function is called. The contract normalizes via TickerLib and uses
        // keccak256(bytes(canonical)) as its uniqueness key, so a single
        // divergent character would produce a different hash than the form's
        // collision check used. The display name travels ONLY in the pinned
        // metadata (`fields.name` went into the /api/metadata body above) —
        // `reserve` takes just the ticker, which becomes the on-chain symbol.
        //
        // Epic 2.6: a snapshotted credit launch sends `value: 0n` — the
        // contract consults the Filter Club pass exactly when msg.value is
        // zero and consumes a credit instead of ETH.
        launch({
          ticker: canonicalSymbol(fields.ticker),
          metadataURI: json.uri,
          valueWei: snap.creditApplied ? 0n : snap.nextCostWei + snap.stakeWei,
        });
      } catch (e) {
        setPinError(e instanceof Error ? e.message : String(e));
        setPinning(false);
      }
    },
    // `launch`/`resetLaunch` are stable; `nextSlotIndex`/`nextCostWei`/
    // `stakeWei`/`stakeReady`/`creditApplied` are captured at click time
    // intentionally — the useCallback re-binds on every render so the click
    // reads the latest values, then snapshots them. If we read these via a
    // ref the snapshot would race the closure (the H-Web-2 root-cause).
    [launch, resetLaunch, nextSlotIndex, nextCostWei, stakeWei, stakeReady, creditApplied],
  );

  // On success, redirect to the homepage (the arena IS the homepage as of
  // PR #39 follow-up) with the new token selected. Run inside an effect so
  // navigation is a side effect, not a render-phase action — the latter
  // double-fires under React Strict Mode and breaks the React rules.
  //
  // Queued pre-activation reservations (slots 1–3) emit no `TokenLaunched`
  // in the reserve tx, so `launchedToken` stays null on success — fall back
  // to the plain arena redirect; the reservation surfaces on the slot grid
  // via the launch-status overlay once the indexer catches the event.
  useEffect(() => {
    if (phase !== "success") return;
    router.replace(launchedToken ? `/?token=${launchedToken}` : "/");
  }, [phase, launchedToken, router]);

  const phaseForButton = pinning ? "pinning" : phase;
  const combinedError = pinError ?? txError;

  // Audit H-Web-2: snapshot is "in-flight" while the user has clicked submit
  // and the tx hasn't yet succeeded or errored back. Drives the badge that
  // shows the user the cost commitment they signed for.
  const snapshotInFlight =
    snapshot !== null &&
    (pinning || phase === "signing" || phase === "broadcasting");

  // Champion pool drives the calculator's "typical bounty" range. /season
  // returns it as a decimal-ETH string; the calculator wants a number. Pass
  // null when no season is loaded so the panels fall back to heuristics
  // rather than rendering "0 ETH bounty" which would mislead.
  const championPoolEth = season?.championPool ? Number(season.championPool) : null;

  return (
    <div style={{position: "relative", minHeight: "100vh", overflow: "hidden"}}>
      <Stars />
      <ArenaTopBar season={season} liveStatus={liveStatus} />
      {dataError && <DataErrorBanner error={dataError} />}

      <main className="ff-launch-page" style={{position: "relative", zIndex: 1}}>
        <LaunchHero season={season} slots={slots} status={status} onScrollToForm={scrollToForm} />

        {/* Epic 1.15c — pending-refund banner. Renders above the fold ONLY when
            the connected wallet has unclaimed slots from prior aborted
            seasons; returns null otherwise (no layout shift). */}
        <PendingRefundBanner />

        <FilterStrip />

        <div className="ff-launch-body" ref={formRef}>
          <SlotGrid slots={slots} />
          <div style={{display: "flex", flexDirection: "column", gap: 14}}>
            {/* Audit M-Web-5 (Phase 1, 2026-05-02): visible only on tablet
                (<1100 px) where the form drops below the slot grid. CSS
                hides this on desktop. The hint connects the two visual
                regions so the form doesn't feel orphaned beneath a long
                slot grid. */}
            <div className="ff-launch-stack-hint" aria-hidden>
              ↑ Pick / inspect a slot above · Launch form ↓
            </div>
            {seasonId === null ? (
              <NoticeCard tone="info" title="Connecting to launcher…" body="Reading current season state from the contract." />
            ) : eligibility.formVisible ? (
              <>
                {snapshotInFlight && snapshot !== null && (
                  <SnapshotBadge snapshot={snapshot} phase={phaseForButton} />
                )}
                <LaunchForm
                  slotIndex={nextSlotIndex}
                  launchCostWei={nextCostWei}
                  stakeWei={stakeWei}
                  cohort={cohort}
                  seasonId={seasonId !== undefined ? Number(seasonId) : null}
                  phase={phaseForButton}
                  error={combinedError}
                  onSubmit={onSubmit}
                  championPoolEth={championPoolEth}
                  /* Epic 2.6 — Filter Club credit toggle. The page owns the
                     state (it decides the tx value); the form renders the
                     control only when the wallet holds credit. */
                  clubCredits={hasCredit ? totalCredits : 0n}
                  creditApplied={creditApplied}
                  onCreditToggle={setUseCredit}
                  /* Audit M-Ux-4 (Phase 1, 2026-05-03): drive CostPanel's
                     "show dashes" mode while the launcher status read
                     hasn't resolved. The page already detects the loading
                     window via `status === undefined` (line ~58); this
                     just hands that signal to the panel so it doesn't
                     render Ξ 0.0000 ($0) before the read lands. The
                     page also has the stake-mode-undefined case
                     (`stakeOn === undefined`); fold that in so a slow
                     `refundableStakeEnabled` read also dashes the
                     stake row instead of guessing it's zero. */
                  costLoading={status === undefined || !stakeReady}
                />
              </>
            ) : (
              <NoticeCard
                tone={eligibility.state === "loading" ? "info" : "warn"}
                title={titleFor(eligibility.state)}
                body={eligibility.message}
                /* Audit M-Web-6 (Phase 1, 2026-05-02): the "Checking
                   eligibility…" card looked frozen pre-fix because it had no
                   indication that work was happening. Apply ff-pulse to the
                   title only when eligibility is actively loading so the
                   dim/warn states (already-launched, window-closed) stay
                   stable. */
                pulseTitle={eligibility.state === "loading"}
              />
            )}
          </div>
        </div>

        {/* ROI calculator (Epic 2.10 / spec §45). Always rendered — visible
            even when the form is locked (already-launched, window-closed)
            so creators can still model future-week scenarios. */}
        <RoiCalculator slotCostWei={nextCostWei} stakeWei={stakeWei} />
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

/// Audit H-Web-2 — locked-snapshot status badge. Renders during the window
/// between user submit-click and tx success/failure, showing the user the
/// exact slot + cost they signed for so the cost commitment stays visible
/// during the multi-second pin → sign → broadcast pipeline. Without this
/// the user has no way to verify what's being paid against the live cost on
/// the right of the form, and a tier rollover during pinning would
/// previously have silently re-priced the launch.
function SnapshotBadge({
  snapshot,
  phase,
}: {
  snapshot: {slotIndex: number; nextCostWei: bigint; stakeWei: bigint; creditApplied: boolean};
  phase: string;
}) {
  // Epic 2.6: a credit launch sends Ξ0 — say WHY, not just the zero, so the
  // badge can't be misread as the M-Ux-4 "loading rendered as free" bug.
  const totalEth = snapshot.creditApplied
    ? "0 · Filter Club credit"
    : formatEther(snapshot.nextCostWei + snapshot.stakeWei);
  const phaseLabel =
    phase === "pinning"
      ? "Pinning metadata…"
      : phase === "signing"
        ? "Sign in your wallet…"
        : phase === "broadcasting"
          ? "Broadcasting…"
          : "Reserving…";
  return (
    <section
      role="status"
      aria-live="polite"
      style={{
        padding: "10px 14px",
        borderRadius: 10,
        border: `1px solid ${C.cyan}66`,
        background: `${C.cyan}1f`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <span
        style={{
          fontFamily: F.mono,
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: "0.16em",
          color: C.cyan,
          textTransform: "uppercase",
        }}
      >
        Reserving slot #{String(snapshot.slotIndex + 1).padStart(2, "0")} · Ξ{totalEth}
      </span>
      <span style={{fontSize: 11, color: C.dim, fontFamily: F.mono}}>{phaseLabel}</span>
    </section>
  );
}

function NoticeCard({
  tone,
  title,
  body,
  pulseTitle = false,
}: {
  tone: "info" | "warn";
  title: string;
  body: string;
  /// Audit M-Web-6: when true, applies the `ff-pulse` keyframe to the title
  /// node so the user sees that work is in flight. Caller drives this so the
  /// pulse fires for the loading state but stays calm for warn/info final
  /// states (already-launched, window-closed) where pulsing would mis-signal.
  pulseTitle?: boolean;
}) {
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
        className={pulseTitle ? "ff-pulse" : undefined}
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
