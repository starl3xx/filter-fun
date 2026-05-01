"use client";

/// Countdown clock for the pre-filter stage (spec §21.2).
///
/// Big center-screen MM:SS in JetBrains Mono, brand cream. Sub-line carries
/// the locked spec copy ("Top 6 survive. Bottom 6 get cut."). When the
/// countdown drops below ten seconds the digits pulse harder — the same
/// 1.4s cadence the cut line uses, dialed to ~0.6s for the final ten.
///
/// The component is purely presentational — `secondsUntil` is owned by
/// `useFilterMoment` so the page-level overlay can drive both this clock
/// and the leaderboard's urgent state from one source.

import {Triangle} from "@/components/Triangle";
import {C, F} from "@/lib/tokens";

export type CountdownClockProps = {
  /// Negative is clamped to 0 — the recap is what shows after T-0, not
  /// "FILTER IN -00:01".
  secondsUntil: number;
  /// Variant: `large` is the pre-filter centerpiece, `compact` is the recap
  /// banner ("next phase in HH:MM:SS").
  variant?: "large" | "compact";
};

export function CountdownClock({secondsUntil, variant = "large"}: CountdownClockProps) {
  const s = Math.max(0, secondsUntil);
  const formatted = formatMmSs(s);
  const final10 = s > 0 && s <= 10;

  if (variant === "compact") {
    return (
      <div
        aria-label={`Filter in ${formatted}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          fontFamily: F.mono,
          fontSize: 13,
          fontWeight: 800,
          color: C.text,
          letterSpacing: "0.08em",
        }}
      >
        <Triangle size={12} inline />
        <span>NEXT PHASE IN</span>
        <span style={{color: C.yellow, fontVariantNumeric: "tabular-nums"}}>{formatted}</span>
      </div>
    );
  }

  return (
    <div
      role="timer"
      aria-live="polite"
      aria-label={`Filter in ${formatted}`}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 18,
        textAlign: "center",
        padding: "0 18px",
        // Don't let the clock text hit the screen edges on narrow viewports.
        maxWidth: "min(92vw, 760px)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontFamily: F.mono,
          fontSize: 12,
          fontWeight: 800,
          color: C.red,
          letterSpacing: "0.32em",
          textTransform: "uppercase",
        }}
      >
        <Triangle size={14} inline />
        <span>FILTER IN</span>
        <Triangle size={14} inline />
      </div>
      <div
        // The pulsing class matches the spec's "harder pulse" intent —
        // 1.4s in normal pre-filter, ~0.6s in the final ten seconds.
        className={final10 ? "ff-filter-moment-clock-urgent" : "ff-filter-moment-clock-pulse"}
        style={{
          fontFamily: F.mono,
          fontWeight: 800,
          fontSize: "clamp(72px, 14vw, 168px)",
          lineHeight: 1,
          color: final10 ? C.red : C.text,
          fontVariantNumeric: "tabular-nums",
          textShadow: final10
            ? `0 0 28px ${C.red}cc, 0 0 64px ${C.red}66`
            : `0 0 18px rgba(255, 235, 255, 0.4)`,
          letterSpacing: "-0.02em",
        }}
      >
        {formatted}
      </div>
      <div
        style={{
          fontFamily: F.display,
          fontSize: "clamp(14px, 2vw, 20px)",
          fontWeight: 800,
          color: C.dim,
          letterSpacing: "0.04em",
        }}
      >
        Top 6 survive. Bottom 6 get cut.
      </div>
    </div>
  );
}

/// MM:SS formatter — never returns three-digit minutes since the pre-filter
/// window is at most 10 minutes (spec §21.2). Kept private to the clock so
/// it doesn't leak into the broader arena-format module.
function formatMmSs(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${pad(m)}:${pad(s)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
