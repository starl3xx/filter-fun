import type {Address, Phase} from "../types.js";

/// One row of harness output: a token's HP composite + component breakdown
/// + raw input snapshot at one tick boundary. The `timeseries: TickRecord[]`
/// returned by `runScenario` is the canonical machine-readable artifact —
/// CLI output, Track E replay diffs, and any future analytics dashboards
/// consume this shape directly. Schema is stable; additive changes only.
export interface TickRecord {
  /// ISO-8601 wall-clock timestamp derived from `ts` against the scenario's
  /// `startWallTime` (default 1970-01-01T00:00:00Z + ts seconds). Wall time
  /// is purely informational — `tick` and `tsSec` are the determinism keys.
  timestamp: string;
  /// Raw simulation timestamp in seconds (matches the input event stream).
  tsSec: number;
  /// Tick index, starting at 0 for the first scored tick. Monotonic.
  tick: number;
  /// Token address as it appeared in the event stream (lowercased to match
  /// downstream consumers — the indexer already lowercases for map keys).
  tokenId: Address;
  /// Composite HP, rendered 0-100 to match the spec §6.6 / §26.4 example
  /// JSON. The underlying scoring package returns [0, 1]; the harness
  /// multiplies by 100 here for output.
  hp: number;
  /// Active phase used to pick weights at this tick.
  phase: Phase;
  /// Five per-component scores in [0, 1]. Weights are not in this record
  /// because they're constant per (phase, config) and would bloat the JSON;
  /// callers can recover them via `weightsForPhase(phase)` from the scoring
  /// package.
  components: {
    velocity: number;
    effectiveBuyers: number;
    stickyLiquidity: number;
    retention: number;
    momentum: number;
  };
  /// Snapshot of the raw inputs the engine consumed to compute HP at this
  /// tick. Bigints are serialized as decimal strings so the JSON is
  /// roundtrippable without custom JSON.parse logic.
  raw: {
    uniqueWallets: number;
    totalVolumeWeth: string;
    lpDepthWeth: string;
    avgLpDepthWeth: string;
    recentLpRemovedWeth: string;
    holderCount: number;
  };
}

/// Result of running one scenario through the engine. `assertionResults` is
/// empty when no assertions were registered. `assertionsPassed` is true iff
/// every registered assertion returned `passed: true`.
export interface ScenarioResult {
  timeseries: TickRecord[];
  /// Final composite HP per token (0-100), measured at the last tick.
  finalHP: Map<Address, number>;
  assertionsPassed: boolean;
  assertionResults: AssertionResult[];
}

export interface AssertionResult {
  description: string;
  passed: boolean;
  /// Free-form context — the actual measured value, or what failed —
  /// surfaced in test output and CLI error reporting.
  detail?: string;
}

/// Predicate over a finished scenario. Returns one assertion result;
/// scenarios may register multiple. The shape matches `Result<T,E>` patterns
/// rather than throwing so the harness can report all failures at once.
export type Assertion = (
  args: {timeseries: TickRecord[]; finalHP: Map<Address, number>},
) => AssertionResult;
