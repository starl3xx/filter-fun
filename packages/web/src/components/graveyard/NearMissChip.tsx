"use client";

/// Near-miss / squeaker margin chip — Epic 1.27 (spec §36.3.3).
///
/// Renders the "filtered by 1.2 HP" / "won by 2.4 HP" callout that threads
/// through graveyard rows, winner detail pages, and profile stats. The
/// margin is supplied as an integer HP delta on the `[0, 10000]` composite
/// scale (Epic 1.18); we render it as a percentage-point value (HP / 100)
/// since "0.4 HP" reads cleaner than "40 HP" at the 5pp threshold.
///
/// Don't-change posture (per spec §36.3.3): the chip MUST NOT render when
/// `marginHp === null` (pre-cut / pre-finalize). Callers gate on
/// `isNearMiss`/`isSqueaker` themselves; this component renders unconditionally
/// when invoked, so callers conditionally include `<NearMissChip ... />`.

import {C, F} from "@/lib/tokens";

export type NearMissChipVariant = "filtered" | "won";

export type NearMissChipProps = {
  marginHp: number;
  variant: NearMissChipVariant;
  /// Optional className for layout integration.
  className?: string;
};

const VARIANT_META: Record<NearMissChipVariant, {color: string; glyph: string; label: string}> = {
  // Filtered-side: the token finished ≤500 HP below the cut line. Pink/red
  // stays consistent with the broadcast filter palette (▼ = filter motif).
  filtered: {color: C.red, glyph: "▼", label: "filtered by"},
  // Winner-side: the winning token won by ≤500 HP. Yellow ties to the
  // weekly-winner badge palette.
  won: {color: C.yellow, glyph: "▲", label: "won by"},
};

export function NearMissChip({marginHp, variant, className}: NearMissChipProps) {
  const meta = VARIANT_META[variant];
  const formatted = formatMarginHp(marginHp);
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 999,
        background: `${meta.color}1c`,
        border: `1px solid ${meta.color}66`,
        color: meta.color,
        fontFamily: F.mono,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden="true">{meta.glyph}</span>
      <span>
        {meta.label} {formatted}
      </span>
    </span>
  );
}

/// Render the integer HP delta as a percentage-point string with at most
/// 1 decimal. Because the composite scale is `[0, 10000]` and the threshold
/// is 500 (5pp), single decimals strike the right resolution: "0.4 HP",
/// "1.2 HP", "5.0 HP". An integer-multiple-of-100 margin renders without
/// the trailing zero ("3 HP" not "3.0 HP").
export function formatMarginHp(marginHp: number): string {
  const pp = marginHp / 100;
  if (Number.isInteger(pp)) return `${pp} HP`;
  return `${pp.toFixed(1)} HP`;
}
