/// Spec §6.6 — internal HP component names ("velocity", "effectiveBuyers", …)
/// MUST be translated before render. This is the single source of truth for
/// the user-facing labels; importing from here is the only sanctioned way to
/// title an HP component on the Arena page.

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
