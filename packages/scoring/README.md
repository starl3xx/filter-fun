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

### Effective buyers — economic-significance dampening

- For each wallet with cumulative buy volume above `buyerDustFloorWeth`: `f(volume)`, where `f` is configurable via `config.effectiveBuyersFunc`:
  - **`"sqrt"` (default, spec §6.4.2).** 30 wallets at 1 WETH ≈ 3.0e10, single whale at 1000 WETH ≈ 3.16e10 — distributed buying still wins on headcount but a real whale isn't completely flattened. Gentler at the top end.
  - **`"log"`.** 30 wallets at 1 WETH ≈ 1242, whale at 1000 WETH ≈ 48 — heavy headcount preference, useful when broad participation is the entire signal.
- Wallets below the dust floor contribute exactly zero (sybil resistance — no signal from a sea of 1-wei addresses) regardless of which function is selected.
- Sum across wallets; min-max normalize across the cohort.

### Sticky liquidity — time-weighted depth, withdrawal-penalized

- Base value: `avgLiquidityDepthWeth` (trailing time-weighted) if provided, else `liquidityDepthWeth`.
- Penalty: `(recentLiquidityRemoved / avgDepth) × α`, where α = `recentWithdrawalPenalty`. **Default α = 1.0** (spec §6.4.3): a 100%-of-depth recent withdrawal fully zeroes the sticky score; a 50%-of-depth withdrawal halves it. Lower values soften the penalty for tuning.
- Min-max normalize across the cohort.

> **Indexer responsibility.** Protocol-controlled LP unwinds during filter events (settlement teardowns, system actions) are not market signal. The indexer must exclude those tx hashes from `recentLiquidityRemovedWeth` upstream of scoring (filter by tx originator). Scoring trusts whatever input is supplied; it cannot tell system actions apart from user actions on its own.

### Retention — two-anchor holder conviction

- Long anchor (e.g. 24h ago): `currentHolders ∩ longAnchor / longAnchor.size`.
- Short anchor (e.g. 1h ago, optional): same fraction over recent set.
- Combined: `(longWeight × long + shortWeight × short) / (longWeight + shortWeight)`. Defaults: 60/40.
- Already in `[0, 1]` — *not* min-max normalized, so a cohort where everyone has perfect retention all keeps full score.

### Momentum — bounded recent acceleration

- `delta = currentBaseComposite − priorBaseComposite`.
- `momentum = clip(delta / momentumScale, −1, 1)` mapped to `[0, 1]`.
- Then clipped by `momentumCap` (default `1.0` = no extra cap beyond normalization). Operators can tighten — e.g. `0.5` caps momentum's HP contribution to half its weight — if empirical data shows momentum-driven rank flips.
- If no prior is supplied, momentum defaults to neutral (`0.5`) so first-tick tokens aren't punished.
- Final HP contribution is `weights.momentum × momentum.score`. With default 10% weight × 1.0 cap, momentum can contribute at most 10 points (out of 100) to HP — so a single late surge cannot flip a token past peers with stronger fundamentals on the other four components.

## Phase weights

| Component         | Pre-filter | Finals | Default |
| ----------------- | ----------:| ------:| -------:|
| Velocity          | 40%        | 30%    | 35%     |
| Effective buyers  | 25%        | 15%    | 20%     |
| Sticky liquidity  | 15%        | 25%    | 20%     |
| Retention         | 10%        | 20%    | 15%     |
| Momentum          | 10%        | 10%    | 10%     |

Pre-filter rewards discovery + breadth (velocity + buyers = 65%, sticky + retention = 25%). Finals rebalances discovery and conviction to parity (45% / 45%) — discovery doesn't lose to conviction; both groups carry equal group weight, but the within-group preference shifts: velocity stays above effective-buyers (30 > 15) so sustained broad buying still climbs, and sticky liq edges retention (25 > 20) so LP commitment outranks holder count. Pass `config.phase` to switch; pass `config.weights` to override entirely (for experiments).

## Configuration

`ScoringConfig` exposes:

- `phase` — `"preFilter" | "finals"`. Picks default weights.
- `weights` — optional override of the five weights.
- `velocityHalfLifeSec` — 24h default.
- `walletCapFloorWeth` — sybil log-cap floor (0.001 WETH default).
- `churnWindowSec` — pump-and-dump window (1h default).
- `buyerDustFloorWeth` — effective-buyers cutoff (0.005 WETH default).
- `effectiveBuyersFunc` — `"sqrt"` (spec default) or `"log"` (heavier headcount preference).
- `retentionLongWeight` / `retentionShortWeight` — 0.6 / 0.4 default.
- `recentWithdrawalPenalty` — α multiplier on the sticky-liq haircut. **1.0 default** (spec §6.4.3): full penalty for recent withdrawals.
- `momentumScale` — full-momentum delta (0.10 default).
- `momentumCap` — hard ceiling on the normalized momentum score. **1.0 default** (no extra cap beyond normalization × weight); operators can tighten if rank-flip noise from momentum is observed.

## Tests

```sh
npm install
npm --workspace @filter-fun/scoring test
```

21 tests cover:

- **basics** — empty input, single-token cohort, ranking by stronger metrics.
- **whale resistance** — distributed wallets outscore a whale on effective buyers; whale-pumped low-mcap tokens lose HP overall when they have thin LP / churning holders.
- **sybil resistance** — dust wallets contribute zero to effective buyers regardless of count; above-floor sybil swarms with thin LP still lose to real distributed buyers via composition.
- **net velocity** — pump-and-dump inside the churn window craters velocity.
- **time decay** — old buys count less than fresh ones.
- **retention** — two-anchor combination; bleeding recent holders penalizes a token with sticky-old retention.
- **sticky liquidity** — recent LP withdrawal hurts sticky-liq even when avg depth is unchanged; α=1.0 zeroes the score on a 100%-of-depth pull; α=0.5 halves it.
- **momentum** — late surger gets a momentum boost capped by weight; first-tick tokens aren't punished; `momentumCap` clips the normalized score for operators who want tighter bounds.
- **effective-buyers function** — `"sqrt"` (default) and `"log"` toggle behave correctly.
- **phase weights** — same cohort ranks differently under pre-filter vs finals; finals weights match spec §6.5 (30/15/25/20/10).
- **§27.6 integration** — steady distributed buying improves HP across all components.

## Outstanding

- Cluster detection (group wallets funded by a common source) — placeholder; the dust floor + log flattening already handle simple sybil patterns. Add cluster heuristics when sybil signal is needed.
- Mission/event multipliers — apply on top of the composite; not implemented yet.
- Persisted scoring snapshots per phase (so Filter-day scores can be compared to Finals-day scores).
