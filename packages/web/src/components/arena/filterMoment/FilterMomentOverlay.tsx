"use client";

/// Top-level overlay for the filter-moment ceremony (Epic 1.9 / spec §21).
///
/// Composes the three dramatic stages on top of the live Arena:
///
///   countdown → CountdownClock + dimming backdrop
///   firing    → FilterEventReveal (broadcast strip)
///   recap     → RecapCard (dismissable center modal)
///
/// The leaderboard underneath stays mounted — its visual transformations
/// (pulse cadence, AT_RISK chips, filtered-row stamps, survivor halos)
/// are owned by `ArenaLeaderboard` via the `urgentCutline` /
/// `firingMode` / `filteredAddresses` / `recentlyFilteredAddresses`
/// props. This overlay only renders the broadcast surface on top.
///
/// Mobile: at <=700px the recap card collapses into a bottom-sheet via
/// the `.ff-filter-moment-mobile-sheet` class — same pattern as the
/// homepage's existing token-detail sheet so the layout idiom stays
/// consistent across the app.

import {useEffect} from "react";

import {sortByRank} from "@/components/arena/ArenaLeaderboard";
import type {SeasonResponse, TokenResponse} from "@/lib/arena/api";

import {CountdownClock} from "./CountdownClock";
import {FilterEventReveal} from "./FilterEventReveal";
import {RecapCard} from "./RecapCard";
import type {FilterMomentStage} from "@/hooks/arena/useFilterMoment";

export type FilterMomentOverlayProps = {
  stage: FilterMomentStage;
  /// Cohort snapshot taken before the firing event landed. Survivors are
  /// the cohort minus the filteredAddresses set. Pre-filter we just pass
  /// the live cohort.
  cohortSnapshot: TokenResponse[];
  /// Addresses that were filtered in the most recent FILTER_FIRED batch.
  filteredAddresses: Set<`0x${string}`>;
  /// Tickers the connected wallet held that were just filtered. Drives
  /// the rollover sub-card's visibility on the recap.
  walletFilteredTickers: string[];
  /// Projected wallet rollover entitlement — null until indexer ships
  /// the per-wallet computation.
  walletEntitlementEth: string | null;
  /// Pool delta + post-filter total for the recap card. The page derives
  /// these from the season-before-firing vs the live season.
  championPoolDelta: string;
  championPoolNow: string;
  /// Seconds remaining until the cut. Drives the countdown clock; null
  /// kills the countdown (defensive — `idle` doesn't render).
  secondsUntilCut: number | null;
  /// Season carrying the settlement anchor for the rollover card.
  season: SeasonResponse | null;
  /// Imperative dismissal — the recap button calls this; the parent then
  /// sets `stage` to `done` via the hook.
  onDismiss: () => void;
  /// Test seam — skips the entry/exit animations.
  skipAnimation?: boolean;
};

export function FilterMomentOverlay(props: FilterMomentOverlayProps) {
  // Esc dismisses the recap. Countdown / firing don't accept Esc — those
  // are not user-cancellable; only the recap is.
  useEffect(() => {
    if (props.stage !== "recap") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.stage, props.onDismiss]);

  if (props.stage === "idle" || props.stage === "done") return null;

  // The backdrop intensity ramps with the stage — countdown is a soft
  // dim, firing flashes red, recap is a stable dim that lets the card
  // dominate the viewport.
  const backdrop = backdropStyleFor(props.stage);

  return (
    <div
      className={`ff-filter-moment-overlay ff-filter-moment-overlay--${props.stage}`}
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: backdrop,
        backdropFilter: "blur(2px)",
        // Countdown + firing don't intercept clicks on the leaderboard
        // beneath; the recap card sets `pointer-events: auto` on itself
        // so its button is clickable.
        pointerEvents: props.stage === "recap" ? "auto" : "none",
        transition: "background 0.35s ease",
      }}
      onClick={() => {
        if (props.stage === "recap") props.onDismiss();
      }}
    >
      {props.stage === "countdown" && props.secondsUntilCut !== null && (
        <CountdownClock secondsUntil={props.secondsUntilCut} />
      )}

      {props.stage === "firing" && (() => {
        // Use the same survivor-set the recap uses (set intersection)
        // rather than a `length - size` subtraction. If a filtered
        // address is somehow missing from the snapshot (stale buffered
        // event, indexer race during a refresh), the subtraction would
        // under- or over-count — possibly negative — and the firing
        // strip would disagree with the recap card 5s later. Bugbot
        // caught this consistency gap.
        const survivors = pickSurvivors(props.cohortSnapshot, props.filteredAddresses);
        const filteredInCohort = props.cohortSnapshot.length - survivors.length;
        return <FilterEventReveal survivors={survivors.length} filtered={filteredInCohort} />;
      })()}

      {props.stage === "recap" && (
        <RecapCard
          survivors={pickSurvivors(props.cohortSnapshot, props.filteredAddresses)}
          walletFilteredTickers={props.walletFilteredTickers}
          championPoolDelta={props.championPoolDelta}
          championPoolNow={props.championPoolNow}
          walletEntitlementEth={props.walletEntitlementEth}
          season={props.season}
          onDismiss={props.onDismiss}
          skipAnimation={props.skipAnimation}
        />
      )}
    </div>
  );
}

// ============================================================ helpers

function backdropStyleFor(stage: FilterMomentStage): string {
  switch (stage) {
    case "countdown":
      return "linear-gradient(180deg, rgba(10, 6, 18, 0.74), rgba(20, 8, 40, 0.86))";
    case "firing":
      return "radial-gradient(ellipse at center, rgba(255, 45, 85, 0.38), rgba(10, 6, 18, 0.92) 65%)";
    case "recap":
      return "rgba(10, 6, 18, 0.78)";
    default:
      return "transparent";
  }
}

/// Survivors = cohort minus the filtered set, sorted by ascending rank.
/// Address comparison is lower-case to match the indexer's canonical form
/// — `filteredAddresses` is normalized in the hook so this is defensive.
/// Reuses `sortByRank` from `ArenaLeaderboard` so the rank-0 fallback
/// stays in lock-step with the leaderboard's ordering — bugbot caught
/// the previous duplicated comparator drift risk.
function pickSurvivors(cohort: TokenResponse[], filtered: Set<`0x${string}`>): TokenResponse[] {
  const f = new Set(Array.from(filtered).map((a) => a.toLowerCase()));
  return sortByRank(cohort.filter((t) => !f.has(t.token.toLowerCase())));
}
