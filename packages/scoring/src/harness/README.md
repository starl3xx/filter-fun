# @filter-fun/scoring/harness

Replay engine that drives the scoring package under controlled event streams. Track A.2 — generalizes the §27.6 hand-built fixtures into a reusable simulator. Reused by:

- **Track B** — synthetic attack scenarios (premature convergence, cold start, viral spike).
- **Track E** — historical replay against Clanker / Bankr / Liquid corpora to empirically validate HP weight values.

## Quickstart

### CLI — built-in canonical scenarios

```sh
npm --workspace @filter-fun/scoring run harness -- wash-trade
npm --workspace @filter-fun/scoring run harness -- whale-pump --out /tmp/wp.json
npm --workspace @filter-fun/scoring run harness -- dust-sybil --seed 42
```

Output is JSON: `{ scenario, seed, config, timeseries[], finalHP, assertionResults[], assertionsPassed }`. Exit code `2` if any registered assertion failed.

### CLI — custom event stream

```sh
npm --workspace @filter-fun/scoring run harness -- ./my-events.json
```

`my-events.json` is a JSON array of `HarnessEvent` (see `events.ts`). `bigint` fields (`ts`, `amountWeth`, `initialLpWeth`) accept either decimal strings (`"1000000000000000000"`) or `{$bigint: "..."}` wrappers.

### Programmatic

```ts
import {Scenario, runScenario} from "@filter-fun/scoring/harness";

const s = new Scenario({seed: 1, startTs: 1_700_000_000n})
  .launch(TOKEN, 10n * WETH)
  .buy(WALLET_A, TOKEN, WETH)
  .advance(60)
  .buy(WALLET_B, TOKEN, WETH);

const result = runScenario(s.build());
console.log(result.timeseries[result.timeseries.length - 1]);
```

`runScenario` also accepts a `ScenarioDefinition` (the canonical scenarios are exports of this shape) — bundles events with assertion predicates so the result includes pass/fail per assertion.

## Scenario authoring

A `ScenarioDefinition` returns `{events, assertions}` from `build({seed})`:

```ts
import {Scenario, type ScenarioDefinition, type Assertion} from "@filter-fun/scoring/harness";

export const myScenario: ScenarioDefinition = {
  name: "my-scenario",
  description: "What this exercises and what it asserts.",
  build({seed}) {
    const s = new Scenario({seed, startTs: 1_700_000_000n});
    // ...emit events via fluent API...
    const assertions: Assertion[] = [
      ({finalHP}) => ({
        description: "test token loses to control",
        passed: (finalHP.get(CONTROL) ?? 0) > (finalHP.get(TEST) ?? 0),
      }),
    ];
    return {events: s.build(), assertions};
  },
};
```

Determinism rules:

- **Use `s.prng` for any randomness** (random wallets, jittered amounts). Never `Math.random` — Track E will diff replay outputs across runs and reject any non-deterministic scenario.
- The `Scenario` clock advances only via `.advance(seconds)`; every other fluent method emits its event at the current clock.
- Stable wallet/token IDs (sequential integers via `addressOf(n)`) keep diff output readable.

## Output schema

Each `TickRecord` in the `timeseries` array:

```ts
{
  timestamp: string;     // ISO-8601 derived from startWallTimeMs + tsSec
  tsSec: number;         // raw simulation seconds (matches the event stream)
  tick: number;          // monotonic, starting at 0
  tokenId: Address;      // lowercased
  hp: number;            // composite, 0-100
  phase: "preFilter" | "finals";
  components: {          // each in [0, 1]
    velocity: number;
    effectiveBuyers: number;
    stickyLiquidity: number;
    retention: number;
    momentum: number;
  };
  raw: {                 // bigint fields serialized as decimal strings
    uniqueWallets: number;
    totalVolumeWeth: string;
    lpDepthWeth: string;
    avgLpDepthWeth: string;
    recentLpRemovedWeth: string;
    holderCount: number;
  };
}
```

Schema is **stable**; additive changes only. Track E's diff harness pins to it.

## Configuration

`HarnessConfig` knobs (all optional, default `DEFAULT_HARNESS_CONFIG`):

| Field | Default | Notes |
|---|---|---|
| `tickGranularitySec` | 60 | HP computed at every multiple from sim start. |
| `retentionAnchorLongSec` | 86400 (24h) | Long-conviction anchor — spec §6.4.4. |
| `retentionAnchorShortSec` | 3600 (1h) | Short-conviction anchor; set 0 to disable. |
| `recentLpWindowSec` | 3600 (1h) | Sticky-liq penalty window — spec §6.4.3. |
| `avgLpWindowSec` | 86400 (24h) | Time-weighted average LP depth window. |
| `startWallTimeMs` | 0 | Wall-clock anchor for ISO-8601 `timestamp`. |
| `scoringConfig` | `DEFAULT_CONFIG` | Full scoring config — phase, weights, dampening, momentum cap. |

## Built-in canonical scenarios

Mirror the spec §27.6 attack patterns. Each pairs a misbehaving "test" token against a healthy "control" token so cohort min-max normalization has signal.

| Scenario | Pattern | Spec §27.6 case |
|---|---|---|
| `wash-trade` | One wallet cycles buy/sell inside churn window. | Whale buy doesn't dominate (single-wallet variant). |
| `whale-pump` | One ~$10k buy, no other activity. | Whale buy doesn't dominate. |
| `dust-sybil` | 1000 wallets each buy just above the dust floor. | Many dust wallets don't dominate. |

Each scenario exposes a `name`, `description`, and `build(seed)` returning events + assertions; `runScenario(scenario)` evaluates everything in one call.

## Performance

Target: 7-day synthetic season (~12k events, 12 tokens, 10k ticks) in under 10s on a modern laptop. Smoke benchmark: ~3s. Suitable for Track E running thousands of replays sequentially.

The dominant cost per tick is min-max normalization across the cohort + the per-token velocity decay loop. For very large cohorts (>100 tokens), consider:

- Pruning holder snapshots older than `retentionAnchorLongSec + grace` (currently retained for the entire run).
- Coarsening tick granularity for long historical runs.

Both are out of scope for A.2.

## Track E adapter shape

The `HistoricalAdapter` type sketches the seam Track E will wire up:

```ts
type HistoricalAdapter = (input: {
  corpusUri: string;
  tokenFilter?: ReadonlyArray<Address>;
  startTs?: bigint;
  endTs?: bigint;
  phaseTransition?: {ts: bigint; phase: Phase};
}) => Promise<HarnessEvent[]>;
```

The adapter pulls historical AMM swap + liquidity data, projects it onto the harness event types, and `runScenario(events)` runs the same engine the canonical scenarios use. Track E's job is the corpus → events translation; the harness contract is stable.
