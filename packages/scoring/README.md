# @filter-fun/scoring

Pure-TypeScript composite **HP** engine. Consumes per-token aggregated metrics (from the indexer) and produces a normalized, ranked leaderboard. Output drives the broadcast UI's HP bar and the oracle's `setFinalists` cut.

> _the token with the strongest real battlefield health wins_

## Output shape

Each ranked token returns:

```ts
{
  token,
  rank,
  hp,            // [0, 1] — sorted desc
  phase,         // "preFilter" | "finals"
  baseComposite, // [0, 1] — pre-momentum, feed back next tick
  components: {
    velocity:        { score, weight, label: "Buying activity"     },
    effectiveBuyers: { score, weight, label: "Real participants"   },
    stickyLiquidity: { score, weight, label: "Liquidity strength"  },
    retention:       { score, weight, label: "Holder conviction"   },
    momentum:        { score, weight, label: "Momentum"            },
  },
}
```

## Inputs (`TokenStats`)

- `volumeByWallet` — cumulative buy volume per wallet (WETH).
- `buys` — per-buy timestamps + wallet + amount.
- `sells` — per-sell timestamps + wallet + amount. Drives net velocity + churn detection.
- `liquidityDepthWeth` / `avgLiquidityDepthWeth` — current depth and time-weighted trailing average.
- `recentLiquidityRemovedWeth` — total LP withdrawn within the recent window. Drives the sticky-liquidity penalty.
- `currentHolders` — wallets with positive balance now.
- `holdersAtRetentionAnchor` — long-window anchor (e.g. 24h ago).
- `holdersAtRecentAnchor` — optional short-window anchor (e.g. 1h ago) so a token can't coast on stale stickiness.
- `priorBaseComposite` — last tick's pre-momentum composite. Producer-managed state.

## Algorithm

```
hp = w_velocity        * velocity
   + w_effectiveBuyers * effectiveBuyers
   + w_stickyLiquidity * stickyLiquidity
   + w_retention       * retention
   + w_momentum        * momentum
```

All five components are normalized to `[0, 1]` across the cohort. Final HP is also `[0, 1]` since weights sum to 1.

### Velocity — decayed net buy inflow

- For each buy: `amount × 2^(-age/halfLife)` (24h half-life by default; recent matters more).
- For each sell: same decay, plus `× 2` if it lands within `churnWindowSec` of a same-wallet buy (pump-and-dump signal).
- Per-wallet `net = max(0, decayed_buys − decayed_sells)`. Pump-and-dump nets to zero.
- Per-wallet net is divided by `log2(1 + walletTotal/floor)` — whales contribute log-scaled, not linearly.
- Sum per-wallet contributions; min-max normalize across the cohort.

### Effective buyers — log-flattened wallet count

- For each wallet with cumulative buy volume above `buyerDustFloorWeth`: `log(1 + volume)`.
- Wallets below the dust floor contribute exactly zero (sybil resistance — no signal from a sea of 1-wei addresses).
- Sum across wallets; min-max normalize.
- The `log` is aggressive: 30 wallets at 1 WETH ≈ 1242, single whale at 1000 WETH ≈ 48. Distributed real participation dominates.

### Sticky liquidity — time-weighted depth, withdrawal-penalized

- Base value: `avgLiquidityDepthWeth` (trailing time-weighted) if provided, else `liquidityDepthWeth`.
- Penalty: `(recentLiquidityRemoved / avgDepth) × recentWithdrawalPenalty`. A 100% recent withdrawal at default penalty (0.5) halves the sticky score.
- Min-max normalize across the cohort.

### Retention — two-anchor holder conviction

- Long anchor (e.g. 24h ago): `currentHolders ∩ longAnchor / longAnchor.size`.
- Short anchor (e.g. 1h ago, optional): same fraction over recent set.
- Combined: `(longWeight × long + shortWeight × short) / (longWeight + shortWeight)`. Defaults: 60/40.
- Already in `[0, 1]` — *not* min-max normalized, so a cohort where everyone has perfect retention all keeps full score.

### Momentum — bounded recent acceleration

- `delta = currentBaseComposite − priorBaseComposite`.
- `momentum = clip(delta / momentumScale, −1, 1)` mapped to `[0, 1]`.
- If no prior is supplied, momentum defaults to neutral (`0.5`) so first-tick tokens aren't punished.
- Capped by its weight (default 10%) so it can never dominate the score — late surges help, but a token still has to have real fundamentals.

## Phase weights

| Component         | Pre-filter | Finals | Default |
| ----------------- | ----------:| ------:| -------:|
| Velocity          | 40%        | 30%    | 35%     |
| Effective buyers  | 25%        | 15%    | 20%     |
| Sticky liquidity  | 15%        | 25%    | 20%     |
| Retention         | 10%        | 20%    | 15%     |
| Momentum          | 10%        | 10%    | 10%     |

Pre-filter rewards discovery + breadth; finals rewards conviction + commitment. Pass `config.phase` to switch; pass `config.weights` to override entirely (for experiments).

## Configuration

`ScoringConfig` exposes:

- `phase` — `"preFilter" | "finals"`. Picks default weights.
- `weights` — optional override of the five weights.
- `velocityHalfLifeSec` — 24h default.
- `walletCapFloorWeth` — sybil log-cap floor (0.001 WETH default).
- `churnWindowSec` — pump-and-dump window (1h default).
- `buyerDustFloorWeth` — effective-buyers cutoff (0.005 WETH default).
- `retentionLongWeight` / `retentionShortWeight` — 0.6 / 0.4 default.
- `recentWithdrawalPenalty` — 0.5 default.
- `momentumScale` — full-momentum delta (0.10 default).

## Tests

```sh
npm install
npm --workspace @filter-fun/scoring test
```

14 tests cover:

- **basics** — empty input, single-token cohort, ranking by stronger metrics.
- **whale resistance** — distributed wallets outscore a whale on effective buyers; whale-pumped low-mcap tokens lose HP overall when they have thin LP / churning holders.
- **sybil resistance** — dust wallets contribute zero to effective buyers regardless of count.
- **net velocity** — pump-and-dump inside the churn window craters velocity.
- **time decay** — old buys count less than fresh ones.
- **retention** — two-anchor combination; bleeding recent holders penalizes a token with sticky-old retention.
- **sticky liquidity** — recent LP withdrawal hurts sticky-liq even when avg depth is unchanged.
- **momentum** — late surger gets a momentum boost capped by weight; first-tick tokens aren't punished.
- **phase weights** — same cohort ranks differently under pre-filter vs finals.

## Outstanding

- Cluster detection (group wallets funded by a common source) — placeholder; the dust floor + log flattening already handle simple sybil patterns. Add cluster heuristics when sybil signal is needed.
- Mission/event multipliers — apply on top of the composite; not implemented yet.
- Persisted scoring snapshots per phase (so Filter-day scores can be compared to Finals-day scores).
