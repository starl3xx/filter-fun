export {applyFlagsToWeights, computeHolderConcentration, computeMomentumComponent, score} from "./score.js";
export type {
  Address,
  ComponentBreakdown,
  Phase,
  ScoredToken,
  ScoringConfig,
  ScoringWeights,
  TokenStats,
  WeightFlags,
} from "./types.js";
export {
  COMPONENT_LABELS,
  DEFAULT_CONFIG,
  DEFAULT_FLAGS,
  DEFAULT_WEIGHTS,
  FINALS_WEIGHTS,
  HP_WEIGHTS_ACTIVATED_AT,
  HP_WEIGHTS_SPEC_REF,
  HP_WEIGHTS_VERSION,
  LOCKED_WEIGHTS,
  PRE_FILTER_WEIGHTS,
  flagsFromEnv,
  weightsForPhase,
} from "./types.js";
