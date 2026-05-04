/// Spec §6.6 — internal HP component names ("velocity", "effectiveBuyers", …)
/// MUST be translated before render. This is the single source of truth for
/// the user-facing labels; importing from here is the only sanctioned way to
/// title an HP component on the Arena page.

import {C} from "../tokens.js";
import type {TokenResponse} from "./api.js";

/// User-facing labels. The `effectiveBuyers` rename "Real participants" →
/// "Buyer breadth" landed 2026-05-05 with the spec §6.6 lock; reverting it
/// breaks the Epic 1.19 tile-view regression test (which pins the new label
/// against the rendered DOM). `holderConcentration` is the 5th locked
/// component (Distribution health) — it's reported on the HP_UPDATED SSE
/// frame today and arrives on the polled `TokenResponse.components` once
/// the indexer follow-up surfacing it ships.
export const HP_LABELS = {
  velocity:            "Buying activity",
  effectiveBuyers:     "Buyer breadth",
  stickyLiquidity:     "Liquidity strength",
  retention:           "Holder conviction",
  momentum:            "Momentum",
  holderConcentration: "Distribution health",
} as const;

/// Display order — spec example renders velocity first, momentum last. We keep
/// the same order in the breakdown panel so reading the list from top-to-bottom
/// matches the spec example.
export const HP_KEYS_IN_ORDER = [
  "velocity",
  "effectiveBuyers",
  "stickyLiquidity",
  "retention",
  "momentum",
] as const satisfies ReadonlyArray<keyof TokenResponse["components"]>;

export type HpKey = (typeof HP_KEYS_IN_ORDER)[number];

/// Tile-view display order (Epic 1.19 — spec §6.6 locked 5-component set).
/// Distinct from `HP_KEYS_IN_ORDER` because the tile drops `momentum` (not
/// part of the locked set) and adds `holderConcentration` (the 5th locked
/// signal). Order matches the spec §19.6.1 example: velocity, effectiveBuyers,
/// stickyLiquidity, retention, holderConcentration.
export const HP_TILE_KEYS_IN_ORDER = [
  "velocity",
  "effectiveBuyers",
  "stickyLiquidity",
  "retention",
  "holderConcentration",
] as const;

export type HpTileKey = (typeof HP_TILE_KEYS_IN_ORDER)[number];

/// ARENA_SPEC §6.5.3 — per-component colour for HP breakdown bars + labels.
/// Spec enumerates four components (Velocity pink / Buyers cyan / Liquidity
/// yellow / Retention green); momentum is a fifth component the indexer reports
/// but the spec doesn't colour, so we assign it C.purple — the only remaining
/// broadcast-palette colour, distinct from all four spec'd ones.
///
/// Audit H-Arena-4 (Phase 1, 2026-05-01): pre-fix every bar used the same
/// cyan→pink gradient, defeating the at-a-glance "which component is weak?"
/// scan the per-component colours enable.
export const HP_COMPONENT_COLORS: Record<HpKey, string> = {
  velocity:        C.pink,
  effectiveBuyers: C.cyan,
  stickyLiquidity: C.yellow,
  retention:       C.green,
  momentum:        C.purple,
} as const;

/// Tile-view per-component colour. Reuses the four locked ARENA_SPEC §6.5.3
/// hues for the spec'd components and assigns purple to holderConcentration —
/// the same broadcast-palette slot momentum had in the row view, since the
/// tile view never shows momentum and holderConcentration. This keeps the
/// "fifth component reads as purple" visual rhythm consistent across views.
export const HP_TILE_COMPONENT_COLORS: Record<HpTileKey, string> = {
  velocity:            C.pink,
  effectiveBuyers:     C.cyan,
  stickyLiquidity:     C.yellow,
  retention:           C.green,
  holderConcentration: C.purple,
} as const;
