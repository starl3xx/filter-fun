/// Public entry point for the HP backtest harness (Track A.2).
///
/// Two surfaces:
///
/// 1. **Programmatic** — `runScenario(...)` for tests and Track E historical
///    replays. Pure function: events + config in, deterministic timeseries
///    + assertion results out.
///
/// 2. **Authored scenarios** — see `./scenarios/*.ts`. Each canonical
///    scenario exports a `ScenarioDefinition` whose `build(prng)` produces
///    the (events, assertions) pair. Authoring a new scenario is the same
///    contract: write a function that returns events + assertions; consume
///    `prng` for any randomness so the scenario stays seed-deterministic.
///
/// The engine itself is intentionally *not* exported — its lifecycle is
/// managed by `runScenario`. Re-import internals only from tests.

import type {Address, Phase} from "../types.js";
import {DEFAULT_HARNESS_CONFIG, ReplayEngine, type HarnessConfig} from "./engine.js";
import type {HarnessEvent} from "./events.js";
import type {Assertion, AssertionResult, ScenarioResult, TickRecord} from "./output.js";
import {Scenario} from "./scenario.js";

export {DEFAULT_HARNESS_CONFIG, type HarnessConfig};
export type {Assertion, AssertionResult, HarnessEvent, ScenarioResult, TickRecord};
export {Scenario};

/// A scenario as a stable definition: name, description, build function. The
/// build function consumes a seedable PRNG and returns the event stream
/// plus zero or more assertions evaluated against the engine output.
///
/// Track E historical replays will import these by `name`, run them on
/// historical data, and diff results against canonical baselines. Keep
/// `name` stable; describe behavior in `description`.
export interface ScenarioDefinition {
  readonly name: string;
  readonly description: string;
  build(opts: {seed: number}): {events: HarnessEvent[]; assertions: Assertion[]};
}

export interface RunScenarioOptions {
  /// PRNG seed for the scenario. Default 1.
  seed?: number;
  /// Per-call config overrides. Merged with `DEFAULT_HARNESS_CONFIG`.
  config?: Partial<HarnessConfig>;
}

/// Run a scenario through the replay engine and evaluate its assertions.
///
/// Accepts either:
/// - A `ScenarioDefinition` (the recommended form — bundles name +
///   assertions with the events).
/// - A raw `HarnessEvent[]` (for ad-hoc / corpus-driven runs where
///   assertions live outside the event stream).
export function runScenario(
  scenario: ScenarioDefinition | ReadonlyArray<HarnessEvent>,
  opts: RunScenarioOptions = {},
): ScenarioResult {
  const seed = opts.seed ?? 1;
  let events: HarnessEvent[];
  let assertions: Assertion[];
  if (Array.isArray(scenario)) {
    events = [...scenario];
    assertions = [];
  } else {
    const def = scenario as ScenarioDefinition;
    const built = def.build({seed});
    events = built.events;
    assertions = built.assertions;
  }
  const config: HarnessConfig = {...DEFAULT_HARNESS_CONFIG, ...opts.config};
  const engine = new ReplayEngine(events, config);
  const timeseries = engine.run();
  const finalHP = computeFinalHP(timeseries);
  const assertionResults: AssertionResult[] = assertions.map((a) =>
    a({timeseries, finalHP}),
  );
  return {
    timeseries,
    finalHP,
    assertionResults,
    assertionsPassed: assertionResults.every((r) => r.passed),
  };
}

/// `Map<token, finalHP>` — the HP from the latest tick that contains each
/// token. Tokens are keyed by their lowercased address (matches `TickRecord`).
function computeFinalHP(timeseries: ReadonlyArray<TickRecord>): Map<Address, number> {
  const out = new Map<Address, number>();
  // Iterate in reverse so the first hit per token is the latest.
  for (let i = timeseries.length - 1; i >= 0; i--) {
    const r = timeseries[i]!;
    if (!out.has(r.tokenId)) out.set(r.tokenId, r.hp);
  }
  return out;
}

/// Sketch of the Track E adapter shape (documented here so future PRs have a
/// clear seam). Historical corpora (Clanker / Bankr / Liquid) implement a
/// function with this signature; `runScenario([...events])` runs the result
/// through the same engine the canonical scenarios use.
export type HistoricalAdapter = (input: {
  corpusUri: string;
  tokenFilter?: ReadonlyArray<Address>;
  startTs?: bigint;
  endTs?: bigint;
  /// Optional phase transition — corpora that span a real season cut
  /// emit a `PHASE` event at the appropriate ts. Adapters for cohort-only
  /// corpora can omit it (engine stays in `preFilter` for the run).
  phaseTransition?: {ts: bigint; phase: Phase};
}) => Promise<HarnessEvent[]>;
