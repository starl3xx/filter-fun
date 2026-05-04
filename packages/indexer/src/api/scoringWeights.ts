/// Pure handler for GET /scoring/weights — public transparency endpoint
/// surfaced by Epic 1.17a (2026-05-03 v4 lock); extended by Epic 1.22
/// (2026-05-04 formula lock) to also expose the named formula constants.
///
/// Reads exclusively from the scoring package's locked exports, so there's
/// no separate config file to maintain — the same import that drives the
/// scoring engine drives the endpoint. External auditors can verify the
/// active set against `HP_WEIGHTS_VERSION` without inspecting commit history.
///
/// **Phase-differentiation** collapsed in v4 (`phaseDifferentiation: false`);
/// a future v5 may revive per-phase weights, in which case this response
/// gains a `weightsByPhase` map and the flag flips. Consumers should branch
/// on `phaseDifferentiation` rather than hardcoding the single-set assumption.
///
/// **Constants** (Epic 1.22): every parameter in `scoring/src/constants.ts`
/// is mirrored under `constants` so a `curl /scoring/weights | jq` is
/// sufficient to verify the active formula configuration without reading
/// source. Bumping `HP_WEIGHTS_VERSION` and any constant must happen in
/// the same release per the weight-update procedure (`docs/scoring-weights.md`
/// §5); the endpoint will reflect both atomically once the indexer redeploys.

import {
  DEFAULT_FLAGS,
  FORMULA_CONSTANTS,
  HP_COMPOSITE_SCALE,
  HP_WEIGHTS_ACTIVATED_AT,
  HP_WEIGHTS_SPEC_REF,
  HP_WEIGHTS_VERSION,
  LOCKED_WEIGHTS,
  flagsFromEnv,
  type FormulaConstants,
  type WeightFlags,
} from "@filter-fun/scoring";

export interface ScoringWeightsResponse {
  /// `HP_WEIGHTS_VERSION` value. Bumped only in lockstep with `weights` *or*
  /// any value in `constants`.
  version: string;
  /// Anchor link to the spec section that authored this weight set + formula
  /// lock. Auditors follow it to verify the on-the-wire values against the
  /// spec text.
  specRef: string;
  /// ISO-8601 wall-clock timestamp at which `version` activated.
  activatedAt: string;
  /// Active component coefficients. Keys mirror `ScoringWeights`.
  weights: {
    velocity: number;
    effectiveBuyers: number;
    stickyLiquidity: number;
    retention: number;
    momentum: number;
    holderConcentration: number;
  };
  /// Live env-driven flag values. Defaults documented in spec §6.4.5 + §41:
  /// `HP_MOMENTUM_ENABLED=false`, `HP_CONCENTRATION_ENABLED=true`.
  flags: {
    HP_MOMENTUM_ENABLED: boolean;
    HP_CONCENTRATION_ENABLED: boolean;
  };
  /// `false` under the v4 lock — both phases resolve to the same weight set.
  /// A future v5 revival of per-phase weights flips this and adds a
  /// `weightsByPhase` field; consumers should branch on this flag.
  phaseDifferentiation: false;
  /// Composite-HP storage + wire scale (Epic 1.18 / spec §6.5). Surfaced for
  /// downstream transparency: clients gating on absolute HP thresholds can
  /// read `min`/`max` here rather than hardcoding the scale. Currently
  /// `{min: 0, max: 10000, type: "integer"}` — bumped from the prior 0-100
  /// integer wire shape with the int10k cutover.
  compositeScale: {
    min: number;
    max: number;
    type: "integer";
  };
  /// Per-component formula constants (Epic 1.22 / spec §6.4.x + §6.7).
  /// Mirrors `FORMULA_CONSTANTS` from the scoring package — every value
  /// the locked formulas depend on, named, exposed, and tagged with
  /// `version`. External auditors should cross-check this object against
  /// the spec amendment for the active version.
  constants: FormulaConstants;
}

/// Builds the `/scoring/weights` response. Pure function — accepts an env
/// snapshot so tests don't need to mutate `process.env`.
export function buildScoringWeightsResponse(
  env: Readonly<Record<string, string | undefined>> = {},
): ScoringWeightsResponse {
  const flags: WeightFlags = flagsFromEnv(env);
  return {
    version: HP_WEIGHTS_VERSION,
    specRef: HP_WEIGHTS_SPEC_REF,
    activatedAt: HP_WEIGHTS_ACTIVATED_AT,
    weights: {
      velocity: LOCKED_WEIGHTS.velocity,
      effectiveBuyers: LOCKED_WEIGHTS.effectiveBuyers,
      stickyLiquidity: LOCKED_WEIGHTS.stickyLiquidity,
      retention: LOCKED_WEIGHTS.retention,
      momentum: LOCKED_WEIGHTS.momentum,
      holderConcentration: LOCKED_WEIGHTS.holderConcentration,
    },
    flags: {
      HP_MOMENTUM_ENABLED: flags.momentum,
      HP_CONCENTRATION_ENABLED: flags.concentration,
    },
    phaseDifferentiation: false,
    compositeScale: {
      min: HP_COMPOSITE_SCALE.min,
      max: HP_COMPOSITE_SCALE.max,
      type: HP_COMPOSITE_SCALE.type,
    },
    constants: FORMULA_CONSTANTS,
  };
}

export {DEFAULT_FLAGS};
