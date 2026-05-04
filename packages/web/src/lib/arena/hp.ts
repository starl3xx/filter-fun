/// HP composite-scale constants — Epic 1.18 (spec §6.5).
///
/// The scoring layer's `HP_COMPOSITE_SCALE` is the source of truth; this file
/// re-exports the bare values for ergonomic import in web components without
/// pulling the entire `@filter-fun/scoring` package's type surface into the
/// React build.
///
/// Keep these values in lockstep with `packages/scoring/src/types.ts`.

export const HP_MIN = 0 as const;
export const HP_MAX = 10000 as const;

/// Bucket thresholds used by `colorForHp` and friends — fractions of the full
/// range, expressed in the integer scale. Pre-1.18 these were 75/50/30 on the
/// 0-100 scale; multiply by 100 for the int10k equivalent. `colorForHp` in
/// `HpBar.tsx` reads these (rather than re-typing the literals) so the
/// canonical thresholds live in one place — matters when a future tuning
/// pass nudges the boundaries.
export const HP_BUCKETS = {
  cyanFloor: 7500,
  greenFloor: 5000,
  amberFloor: 3000,
} as const;
