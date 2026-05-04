# @filter-fun/scoring

Pure-TypeScript composite **HP** engine. Consumes per-token aggregated metrics (from the indexer) and produces a normalized, ranked leaderboard. Output drives the broadcast UI's HP bar and the oracle's `setFinalists` cut.

> _the token with the strongest real battlefield health wins_

## Output shape

Each ranked token returns:

```ts
{
  token,
  rank,
  hp,             // integer in [0, 10000] — sorted desc; ties broken by launchedAt asc, then token addr asc
  phase,          // "preFilter" | "finals"
  baseComposite,  // [0, 1] float — pre-momentum, feed back next tick
  weightsVersion, // active HP_WEIGHTS_VERSION at compute time
  flagsActive,    // { momentum, concentration } at compute time
  components: {
    velocity:            { score, weight, label: "Buying activity"     },
    effectiveBuyers:     { score, weight, label: "Real participants"   },
    stickyLiquidity:     { score, weight, label: "Liquidity strength"  },
    retention:           { score, weight, label: "Holder conviction"   },
    momentum:            { score, weight, label: "Momentum"            },
    holderConcentration: { score, weight, label: "Holder distribution" },
  },
}
```

## Locked weights (`HP_WEIGHTS_VERSION = "2026-05-04-v4-locked-int10k-formulas"`)

| Component           | Weight |
|---------------------|-------:|
| Velocity            | 30%    |
| Effective buyers    | 15%    |
| Sticky liquidity    | 30%    |
| Retention           | 15%    |
| Momentum            | 0%     |
| Holder concentration| 10%    |

Activation: 2026-05-11T00:00:00Z. Sums to 1.0 exactly. Phase weights collapsed to a single set in v4 — `weightsForPhase("preFilter")` and `weightsForPhase("finals")` both return `LOCKED_WEIGHTS`. The phase argument is retained for API stability across a future v5 revival.

## Inputs (`TokenStats`)

- `volumeByWallet` — cumulative buy volume per wallet (WETH).
- `buys` / `sells` — per-event timestamps + wallet + amount. Drive net velocity within the locked 96h lookback window.
- `liquidityDepthWeth` / `avgLiquidityDepthWeth` — current depth and time-weighted trailing average. Pre-1.22 fallback path.
- `lpEvents` — per-event LP timeline (signed WETH delta). Drives the locked exponential-decay sticky-liquidity penalty (§6.4.3). Indexer projection (Epic 1.22b) populates this.
- `currentHolders` — wallets with positive balance now.
- `holdersAtRetentionAnchor` / `holdersAtRecentAnchor` — long + short anchors for retention.
- `holderBalancesAtRetentionAnchor` / `holderFirstSeenAt` / `totalSupply` — per-holder balance + first-seen for the dust-supply filter and ageFactor (§6.4.4). Indexer projection (Epic 1.22b) populates these.
- `holderBalances` — current per-wallet balances (after spec §41.3 protocol/burn/pool exclusion). Drives holderConcentration via HHI.
- `priorBaseComposite` — last tick's pre-momentum composite (ignored under v4 since momentum weight is 0; producers should still keep storing it for a future v5 revival).
- `launchedAt` — unix-seconds, used as the §6.10 tie-break secondary sort key.

## Algorithm — locked formulas (Epic 1.22 §6.4.x)

```
hp = round( 10000 × (
       w_velocity            × velocity
     + w_effectiveBuyers     × effectiveBuyers
     + w_stickyLiquidity     × stickyLiquidity
     + w_retention           × retention
     + w_momentum            × momentum
     + w_holderConcentration × holderConcentration
   ) )
```

Each component score is in `[0, 1]`. The composite is rounded once at the end to an integer in `[0, 10000]` (round-half-up). All five reference-normalized components use **fixed-reference normalization** (§6.7): `clip(raw / *_REFERENCE, 0, 1)`. References are calibrated from the v5 cohort's 90th percentile and are not re-derived per cohort — see `docs/scoring-weights.md` §5b.

### Velocity — decayed net inflow (§6.4.1)

```
for each buy in last VELOCITY_LOOKBACK_SEC (96h):
  contribution = amount × 2^(-age / VELOCITY_DECAY_HALFLIFE_SEC)   # 24h half-life
for each sell in same window:
  same decay; if within VELOCITY_DECAY_HALFLIFE_SEC of a same-wallet buy → × VELOCITY_CHURN_PENALTY_FACTOR
per_wallet_net = clip(buys − sells, 0, VELOCITY_PER_WALLET_CAP_WETH)   # absolute 10 WETH cap
raw = sum(per_wallet_net)
score = clip(raw / VELOCITY_REFERENCE, 0, 1)
```

The cap is **absolute**, not log-flattened — a single whale can contribute at most 10 WETH-equivalent to the cohort's velocity raw. Pump-and-dump within the 24h window is doubly discounted on the sell leg. Out-of-window events are dropped (no soft decay past 96h).

### Effective buyers — sqrt dampening (§6.4.2)

```
qualifying_wallets = { w | volumeByWallet[w] ≥ EFFECTIVE_BUYERS_DUST_WETH }   # 0.001 WETH floor
raw = Σ_{w ∈ qualifying_wallets} sqrt(volumeByWallet[w])
score = clip(raw / EFFECTIVE_BUYERS_REFERENCE, 0, 1)
```

Wallets below the dust floor contribute exactly zero — sybil resistance. The `sqrt` dampening means 30 wallets at 1 WETH outscore one whale at 1000 WETH on real-buyer signal.

### Sticky liquidity — exponential LP penalty (§6.4.3)

```
base = avgLiquidityDepthWeth ?? liquidityDepthWeth
penalty = Σ_{remove events in last LP_PENALTY_WINDOW_SEC (24h)}
            amount × exp(-Δt / LP_PENALTY_TAU_SEC)   # 6h half-life
raw = max(0, base − penalty)
score = clip(raw / STICKY_LIQUIDITY_REFERENCE, 0, 1) × ageFactor
```

`ageFactor` saturates at 1.0 once the token has been observed for ≥ 1h — it exists to prevent a brand-new token from instantly claiming full sticky-liquidity credit before any time-weighted depth has accrued.

### Retention — two-anchor + dust filter + ageFactor (§6.4.4)

```
qualifying_anchor_holders = { h ∈ holdersAtRetentionAnchor |
                              balance[h] / totalSupply ≥ RETENTION_DUST_SUPPLY_FRAC }   # 0.0001
long_ratio  = |currentHolders ∩ qualifying_anchor_holders| / |qualifying_anchor_holders|
short_ratio = |currentHolders ∩ holdersAtRecentAnchor|     / |holdersAtRecentAnchor|     (if recent set)
ratio = (longWeight × long + shortWeight × short) / (longWeight + shortWeight)          (default 60/40)
score = ratio × ageFactor
```

Already in `[0, 1]` — *not* reference-normalized. Dust holders (< 0.01% supply) are excluded from the denominator so a token with 10 000 dust addresses can't claim retention credit on the 50 real holders. When `holderBalancesAtRetentionAnchor` is omitted (pre-1.22 callers / pre-projection rows), the dust filter is skipped and retention reduces to the legacy intersection ratio.

### Holder concentration — HHI (§6.4.6 / §41.4)

```
shares = balances / Σ(balances)
hhi = Σ(shares²)                  # 1.0 = single holder; 1/n = perfectly distributed
score = clip(1 − hhi, 0, 1) × ageFactor
```

Already in `[0, 1]`. Excluded addresses (protocol, burn, pool) MUST be filtered upstream — see `excluded.ts`. Gated by `HP_CONCENTRATION_ENABLED` (default `true`); when off, the remaining five weights renormalize to sum to 1.0.

### Momentum — bounded recent acceleration (§6.4.5)

Disabled under v4 lock (`weight = 0`, `HP_MOMENTUM_ENABLED = false`). When enabled:

```
delta = currentBaseComposite − priorBaseComposite
raw = clip(delta / momentumScale, −1, 1)
score = clip( (raw + 1) / 2, 0, momentumCap )
```

## Tie-break (§6.10)

When two tokens land on the exact-same integer HP, the rank is resolved by:

1. **HP descending** (primary).
2. **launchedAt ascending** (earlier wins).
3. **token address ascending** (stable, Merkle-friendly).

The third tier guarantees a deterministic ranking under any input, so the oracle's posted Merkle root is reproducible from any replay of the indexer state.

## Settlement finality (§6.12)

Every `hpSnapshot` row carries a `finality` tag:

| trigger             | initial finality |
|---------------------|------------------|
| `BLOCK_TICK`, `SWAP`, `HOLDER_SNAPSHOT`, `PHASE_BOUNDARY` | `tip` |
| `CUT`, `FINALIZE`   | `final` |

CUT/FINALIZE rows are inserted ≥ `SETTLEMENT_FINALITY_BLOCKS` (12 blocks) past the wall-clock boundary, so by construction they land as `final` and the oracle Merkle publish reads stable rows. The reorg/finality state machine that advances tip → soft → final for non-settlement rows is the indexer projection's responsibility — Epic 1.22b / PR 2.

## Configuration

`ScoringConfig` exposes:

- `phase` — `"preFilter" | "finals"`. Picks default weights (collapsed to `LOCKED_WEIGHTS` under v4).
- `weights` — optional override (experiments only; production must consume the locked set).
- `flags` — `{momentum, concentration}`. Defaults from env (`HP_MOMENTUM_ENABLED`, `HP_CONCENTRATION_ENABLED`).
- `retentionLongWeight` / `retentionShortWeight` — 0.6 / 0.4 default; behavior knob, not a locked constant.
- `momentumScale` / `momentumCap` — only consulted when `flags.momentum === true`.

**Deprecated** (Epic 1.22 lock — engine reads `constants.ts` instead, fields preserved for type stability):

- `velocityHalfLifeSec` → `VELOCITY_DECAY_HALFLIFE_SEC`
- `walletCapFloorWeth` → replaced by absolute `VELOCITY_PER_WALLET_CAP_WETH`
- `churnWindowSec` → `VELOCITY_DECAY_HALFLIFE_SEC` (same window)
- `buyerDustFloorWeth` → `EFFECTIVE_BUYERS_DUST_WETH`
- `effectiveBuyersFunc` → locked to `sqrt`
- `recentWithdrawalPenalty` → replaced by `LP_PENALTY_TAU_SEC` / `LP_PENALTY_WINDOW_SEC` (still used as a multiplier on the aggregate fallback path when `lpEvents` is omitted)

## Constants reference

All formula constants live in `src/constants.ts` and are surfaced via the `/scoring/weights` endpoint under `response.constants`. Bumping any of these requires the same procedure as a weight change — see `docs/scoring-weights.md` §5b.

## Tests

```sh
npm install
npm --workspace @filter-fun/scoring test
```

Coverage:

- **basics** — empty input, single-token cohort, ranking by stronger metrics.
- **whale resistance** — distributed wallets outscore a whale on effective buyers; whale-pumped low-mcap tokens lose HP overall when they have thin LP / churning holders.
- **sybil resistance** — dust wallets contribute zero to effective buyers regardless of count.
- **net velocity** — pump-and-dump inside the churn window craters velocity; per-wallet absolute cap holds.
- **time decay** — old buys count less than fresh ones; events outside the 96h window contribute nothing.
- **retention** — two-anchor combination; dust filter; ageFactor saturation.
- **sticky liquidity** — `exp(-Δt / 6h)` LP-removal penalty; α=1.0 zeroes a 100%-of-depth pull on the aggregate fallback path.
- **holder concentration** — HHI; flag gate renormalizes the remaining weights.
- **tie-break** — three-tier sort across HP, launchedAt, token address.
- **finality** — CUT/FINALIZE → `final`, other triggers → `tip`.
- **fixture suite** — parameterized JSON fixtures (≥5 per component + 10 composite) under `test/fixtures/`. `inv_hp_formula_pure` runs each fixture 100× and asserts byte-identical output.
- **Track E v5 refit** — locked formulas + fixed-reference normalization → ρ = +0.4212 vs FDV at n=43 (`track-e/REPORT_v5_formula_lock.md`).

## Backtest harness

For driving the scoring engine across thousands of synthetic or historical seasons, see [`src/harness/`](./src/harness/README.md). Three canonical scenarios ship with the harness (wash-trade, whale-pump, dust-sybil), runnable from the CLI:

```sh
npm --workspace @filter-fun/scoring run harness -- wash-trade
```

Track B (attack sims) and Track E (HP empirical validation) both consume this harness; the engine is a pure function of `(events, config)` so historical adapters just need to project their corpus onto `HarnessEvent[]`.

## Outstanding

- Cluster detection (group wallets funded by a common source) — placeholder; the dust floor + log flattening already handle simple sybil patterns.
- Mission/event multipliers — apply on top of the composite; not implemented yet.
- Indexer projection (Epic 1.22b / PR 2) — populate `lpEvents`, `holderBalancesAtRetentionAnchor`, `holderFirstSeenAt`, `totalSupply` on `TokenStats`. Until then, those fields fall back to pre-1.22 aggregate paths and the `inv_hp_settlement_finality` advancer (tip → soft → final) is not yet running.
