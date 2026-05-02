"use client";

/// Stage 2 reveal — the ~5s broadcast of the filter event itself
/// (spec §21.3). Sequence:
///
///   1. The page backdrop flashes red and dims further.
///   2. A full-width announcement strip drops in:
///        ▼ FILTER LIVE — 6 SURVIVED
///   3. Survivor halos + filtered stamps run as a CSS-only ramp on
///      the underlying leaderboard (driven via `firingMode` + the
///      filtered-address set on `ArenaLeaderboard`).
///
/// The component owns only the broadcast strip + backdrop flash. The
/// leaderboard transformations live where the leaderboard is, so the
/// freeze + stamp + halo all stay co-located with the row layout.
///
/// Copy is brand-locked — "FILTER LIVE ▼ — 6 SURVIVED" mirrors the spec
/// example. We never address the user directly here ("you got filtered!"
/// is out of scope per the brief); the tone is broadcast/sports neutral.

import {Triangle} from "@/components/Triangle";
import {C, F, SURVIVE_COUNT} from "@/lib/tokens";

export type FilterEventRevealProps = {
  /// Number of tokens that survived the cut. Defaults to the protocol-locked
  /// SURVIVE_COUNT (6) — passed explicitly so a future cohort-size change in
  /// one place doesn't require touching this component too.
  survivors?: number;
  /// Number filtered. Defaults to `survivors` (mirror) — the brief example
  /// has "6 SURVIVED" on a 12-token field, so symmetry holds.
  filtered?: number;
};

export function FilterEventReveal({survivors = SURVIVE_COUNT, filtered = SURVIVE_COUNT}: FilterEventRevealProps) {
  return (
    <div
      role="status"
      aria-live="assertive"
      aria-label={`Filter live — ${survivors} survived, ${filtered} filtered`}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        pointerEvents: "none",
      }}
    >
      <div
        className="ff-filter-moment-strip"
        style={{
          width: "min(92vw, 920px)",
          padding: "26px 32px",
          textAlign: "center",
          background: `linear-gradient(90deg, ${C.red}26, ${C.red}66, ${C.red}26)`,
          border: `2px solid ${C.red}`,
          borderRadius: 18,
          boxShadow: `0 0 48px ${C.red}aa, inset 0 0 32px ${C.red}55`,
          color: C.text,
          fontFamily: F.display,
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 14,
            fontWeight: 900,
            fontSize: "clamp(28px, 5vw, 48px)",
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            textShadow: `0 0 24px ${C.red}cc`,
          }}
        >
          <Triangle size={28} inline />
          <span>FILTER LIVE</span>
          <Triangle size={28} inline />
        </div>
        <div
          style={{
            marginTop: 10,
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: "clamp(14px, 1.6vw, 20px)",
            color: C.text,
            letterSpacing: "0.18em",
          }}
        >
          <span style={{color: C.green}}>{survivors} SURVIVED</span>
          <span style={{color: C.faint, margin: "0 12px"}}>·</span>
          <span style={{color: C.red}}>{filtered} FILTERED</span>
        </div>
      </div>
    </div>
  );
}
