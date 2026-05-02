/// Spec §6.6 — internal HP component names ("velocity", "effectiveBuyers", …)
/// MUST be translated before render. This is the single source of truth for
/// the user-facing labels; importing from here is the only sanctioned way to
/// title an HP component on the Arena page.

import {C} from "../tokens.js";
import type {TokenResponse} from "./api.js";

export const HP_LABELS = {
  velocity:        "Buying activity",
  effectiveBuyers: "Real participants",
  stickyLiquidity: "Liquidity strength",
  retention:       "Holder conviction",
  momentum:        "Momentum",
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
