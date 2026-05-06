"use client";

/// Arena scoreboard hero — Epic 1.28.
///
/// Three-card hero block at the top of the arena page (above the leaderboard).
/// Replaces the small `PoolsCard` in the left column with the cut clock as
/// the dominant focal point of the page.
///
/// **Pre-launch state branching.** The hero renders coherently across four
/// season states (per spec §46 deferred-activation + §6.10 cohort-edge):
///
///   1. Pre-week (reservation phase, phase=launch, reservationCount<12) —
///      countdown reframed as "Reservations close in HH:MM:SS"; mini-stats
///      show "0/12 reservations · activates at 4". Filter Fund + Reserve
///      cards show "Awaiting activation".
///   2. Aborted week (<4 reservations after window close) — hero muted at
///      50% opacity; countdown disabled; status reads "Refunds processed".
///   3. Sub-12 active week (sub-12 cohort) — §6.10 cohort-edge math drives
///      the survivor / cut split (e.g. 11 active → 5 survive / 6 cut).
///   4. Steady-state full cohort (12 active) — the mock's default, 12/6/6.
///
/// Mirrors the visual treatment in `design-explore/front-page-v2.html`.

import {useEffect, useState} from "react";

import type {SeasonResponse, TokenResponse} from "@/lib/arena/api";
import {fmtCutCountdown, fmtEth, secondsUntil} from "@/lib/arena/format";
import {C, F} from "@/lib/tokens";

const FULL_COHORT_SIZE = 12;
const MIN_ACTIVATION_RESERVATIONS = 4;

export type ArenaScoreboardHeroProps = {
  season: SeasonResponse | null;
  cohort: ReadonlyArray<TokenResponse>;
  /// Pre-launch reservation count. Optional — when undefined we infer from
  /// `season.launchCount` for steady-state pages. Wired in by callers that
  /// also poll `/season/:id/launch-status`.
  reservationCount?: number;
  /// True when the deferred-activation window closed without reaching
  /// `MIN_ACTIVATION_RESERVATIONS`. Drives the muted "Refunds processed"
  /// rendering. Optional — when undefined the component infers from a
  /// settled / post-launch season with empty cohort and no champion pool.
  aborted?: boolean;
};

type HeroState = "reservation" | "aborted" | "active";

export function ArenaScoreboardHero({season, cohort, reservationCount, aborted}: ArenaScoreboardHeroProps) {
  const state = deriveHeroState({season, cohort, reservationCount, aborted});
  return (
    <section
      aria-label="Scoreboard hero"
      data-testid="scoreboard-hero"
      data-hero-state={state}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr)",
        gap: 14,
        // Aborted state mutes the hero so the refund banner reads as the
        // primary signal — but the hero stays mounted so the channels +
        // copy remain visible for context.
        opacity: state === "aborted" ? 0.5 : 1,
      }}
    >
      <CountdownCard state={state} season={season} cohort={cohort} reservationCount={reservationCount} />
      <FilterFundCard state={state} season={season} />
      <LiquidityReserveCard state={state} season={season} />
    </section>
  );
}

/// Internal — exported for tests so the state machine is pinnable without
/// rendering a tree. Order matters: aborted overrides reservation, which
/// overrides active.
export function deriveHeroState({
  season,
  cohort,
  reservationCount,
  aborted,
}: Pick<ArenaScoreboardHeroProps, "season" | "cohort" | "reservationCount" | "aborted">): HeroState {
  if (aborted) return "aborted";
  if (!season) return "reservation";
  if (season.phase === "launch") {
    // Pre-week: still in the reservation window. The §46 deferred-activation
    // policy treats `phase=launch` + sub-cohort cohort as "awaiting
    // activation" — even if a few tokens have launched, the season hasn't
    // crossed the activation threshold and the hero shouldn't pretend a
    // cut clock matters yet.
    if ((reservationCount ?? cohort.length) < FULL_COHORT_SIZE) return "reservation";
  }
  return "active";
}

/// Cohort-edge math — spec §6.10. With a sub-12 cohort the survivor / cut
/// split drops symmetrically: 11 active → 5 survive / 6 cut; 9 → 4 / 5;
/// 8 → 4 / 4; 7 → 3 / 4. Steady-state full cohort (12) is the mock default
/// of 6 / 6.
export function cohortEdgeSplit(active: number): {survivors: number; cut: number} {
  if (active <= 0) return {survivors: 0, cut: 0};
  // Round-down survivors so the cut-side bears the burden of an odd
  // cohort. Matches spec §6.10's example sequence.
  const survivors = Math.floor(active / 2);
  return {survivors, cut: active - survivors};
}

/// Local 1-second tick. SSR-safe (returns the seed until mount), then
/// re-renders every second so the countdown reads as live. Cleanup runs on
/// unmount so a route change doesn't leave the timer running.
function useNowTick(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function CountdownCard({
  state,
  season,
  cohort,
  reservationCount,
}: {
  state: HeroState;
  season: SeasonResponse | null;
  cohort: ReadonlyArray<TokenResponse>;
  reservationCount?: number;
}) {
  const now = useNowTick();
  const secs = season ? secondsUntil(season.nextCutAt, now) : 0;
  const formatted = fmtCutCountdown(secs);
  // Active state: split the formatted string at colons so the separator can
  // pulse independently.
  const segments = formatted.includes(":") ? formatted.split(":") : [formatted];

  const tagText =
    state === "reservation" ? "▼ Awaiting activation" : state === "aborted" ? "▼ Aborted" : "▼ Next filter";
  const helperText =
    state === "reservation"
      ? "Reservations close before the cut clock starts"
      : state === "aborted"
        ? "Window closed before reaching the activation threshold"
        : "Bottom 6 get cut · Liquidity flows to the winner";

  // Active counts. In reservation state we override the "in arena" count
  // with the reservationCount. Aborted state shows the dashboard's last
  // known mini-stats but greys out via the parent opacity.
  const active = state === "reservation" ? reservationCount ?? cohort.length : cohort.length;
  const {survivors, cut} = cohortEdgeSplit(active);

  return (
    <article
      data-testid="hero-card-countdown"
      style={{
        position: "relative",
        padding: "18px 20px",
        borderRadius: 16,
        border: `1px solid ${C.red}66`,
        background:
          `radial-gradient(80% 90% at 50% 0%, ${C.red}2e, transparent 65%), rgba(20,8,40,0.65)`,
        overflow: "hidden",
      }}
    >
      <Tag color={C.red}>{tagText}</Tag>
      {state === "active" ? (
        <div
          aria-label={`Next filter in ${formatted}`}
          style={{
            marginTop: 10,
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: "clamp(32px, 3.6vw, 46px)",
            letterSpacing: "-0.01em",
            fontVariantNumeric: "tabular-nums",
            lineHeight: 0.95,
            color: C.text,
            textShadow: `0 0 18px ${C.red}77`,
            display: "flex",
            alignItems: "baseline",
          }}
        >
          {segments.map((seg, idx) => {
            const isLast = idx === segments.length - 1;
            return (
              <span key={idx} style={{display: "inline-flex", alignItems: "baseline"}}>
                <span>{seg}</span>
                {!isLast && (
                  <span
                    aria-hidden
                    className="ff-pulse"
                    style={{color: C.red, padding: "0 4px"}}
                  >
                    :
                  </span>
                )}
              </span>
            );
          })}
        </div>
      ) : (
        <div
          style={{
            marginTop: 10,
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: "clamp(20px, 2vw, 26px)",
            color: C.faint,
            letterSpacing: "0.04em",
          }}
        >
          {state === "reservation" ? "—" : "—"}
        </div>
      )}
      <div
        style={{
          fontFamily: F.mono,
          fontSize: 10,
          letterSpacing: "0.14em",
          color: C.faint,
          textTransform: "uppercase",
          fontWeight: 700,
          marginTop: 6,
        }}
      >
        {helperText}
      </div>
      <MiniStats state={state} active={active} survivors={survivors} cut={cut} />
    </article>
  );
}

function MiniStats({state, active, survivors, cut}: {state: HeroState; active: number; survivors: number; cut: number}) {
  if (state === "reservation") {
    return (
      <div style={{display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginTop: 12}}>
        <Mini label="Reservations" value={`${active}/${FULL_COHORT_SIZE}`} foot={`activates at ${MIN_ACTIVATION_RESERVATIONS}`} />
        <Mini label="Min cohort" value={`${MIN_ACTIVATION_RESERVATIONS}`} foot="for the season to launch" />
        <Mini label="Status" value="OPEN" foot="reservations accepted" />
      </div>
    );
  }
  if (state === "aborted") {
    return (
      <div style={{display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginTop: 12}}>
        <Mini label="Reservations" value={`${active}`} foot="below activation threshold" />
        <Mini label="Refunds" value="PROCESSED" foot="see refund status" />
        <Mini label="Status" value="ABORTED" foot="see you next week" />
      </div>
    );
  }
  return (
    <div style={{display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginTop: 12}}>
      <Mini label="In arena" value={`${active}`} foot="tokens this week" />
      <Mini label="Survivors" value={`${survivors}`} foot="advance to finals" />
      <Mini label="Cut" value={`${cut}`} foot="filtered out" />
    </div>
  );
}

function Mini({label, value, foot}: {label: string; value: string; foot: string}) {
  return (
    <div
      style={{
        padding: "8px 10px",
        borderRadius: 8,
        border: `1px solid ${C.line}`,
        background: "rgba(255,255,255,0.03)",
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontFamily: F.mono,
          color: C.cyan,
          letterSpacing: "0.16em",
          fontWeight: 700,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: F.mono,
          fontWeight: 800,
          fontSize: 17,
          fontVariantNumeric: "tabular-nums",
          marginTop: 2,
        }}
      >
        {value}
      </div>
      <div style={{fontSize: 10, color: C.dim, marginTop: 1}}>{foot}</div>
    </div>
  );
}

function FilterFundCard({state, season}: {state: HeroState; season: SeasonResponse | null}) {
  const value = state === "active" && season ? fmtEth(season.championPool) : "Ξ —";
  return (
    <article
      data-testid="hero-card-fund"
      style={{
        position: "relative",
        padding: "18px 20px",
        borderRadius: 16,
        border: `1px solid ${C.yellow}44`,
        background:
          `radial-gradient(80% 90% at 50% 0%, ${C.yellow}1a, transparent 65%), rgba(20,8,40,0.55)`,
      }}
    >
      <Tag color={C.yellow}>🏆 Filter Fund</Tag>
      <div
        style={{
          marginTop: 10,
          fontFamily: F.mono,
          fontWeight: 800,
          fontSize: "clamp(30px, 3.4vw, 42px)",
          lineHeight: 0.96,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.015em",
          color: state === "active" ? C.yellow : C.faint,
          textShadow: state === "active" ? `0 0 18px ${C.yellow}44` : undefined,
        }}
      >
        {value}
      </div>
      <p style={{color: C.dim, fontSize: 12, margin: "6px 0 0", lineHeight: 1.45}}>
        {state === "active" ? (
          <>
            Filtered tokens' liquidity flows into the winner — a{" "}
            <b style={{color: C.text, fontWeight: 700}}>2.5% creator bounty</b>, airdrops to{" "}
            <b style={{color: C.text, fontWeight: 700}}>both groups of holders</b> (filtered-token holders via
            rollover, plus winning-token holders via the hold bonus), and{" "}
            <b style={{color: C.text, fontWeight: 700}}>permanent LP</b> (the Liquidity Reserve).
          </>
        ) : (
          "Awaiting activation. The fund grows from filtered-token liquidity once the cut clock starts."
        )}
      </p>
    </article>
  );
}

function LiquidityReserveCard({state, season}: {state: HeroState; season: SeasonResponse | null}) {
  const value = state === "active" && season ? fmtEth(season.polReserve) : "Ξ —";
  return (
    <article
      data-testid="hero-card-reserve"
      style={{
        position: "relative",
        padding: "18px 20px",
        borderRadius: 16,
        border: `1px solid ${C.cyan}44`,
        background:
          `radial-gradient(80% 90% at 50% 0%, ${C.cyan}1a, transparent 65%), rgba(20,8,40,0.55)`,
      }}
    >
      <Tag color={C.cyan}>▼ Liquidity Reserve</Tag>
      <div
        style={{
          marginTop: 10,
          fontFamily: F.mono,
          fontWeight: 800,
          fontSize: "clamp(30px, 3.4vw, 42px)",
          lineHeight: 0.96,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.015em",
          color: state === "active" ? C.cyan : C.faint,
          textShadow: state === "active" ? `0 0 18px ${C.cyan}44` : undefined,
        }}
      >
        {value}
      </div>
      <p style={{color: C.dim, fontSize: 12, margin: "6px 0 0", lineHeight: 1.45}}>
        {state === "active" ? (
          <>
            <b style={{color: C.text, fontWeight: 700}}>Permanent liquidity for the winner.</b> Backstops the
            champion forever. Cannot be withdrawn.
          </>
        ) : (
          "Awaiting activation. Permanent LP for the winner once the cut clock starts."
        )}
      </p>
    </article>
  );
}

function Tag({color, children}: {color: string; children: React.ReactNode}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 99,
        background: `${color}1a`,
        color,
        border: `1px solid ${color}55`,
        fontFamily: F.mono,
        fontWeight: 800,
        fontSize: 10,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}
