# @filter-fun/scoring

Pure-TypeScript composite scoring engine. Consumes per-token aggregated metrics (from the indexer) and produces a normalized, ranked leaderboard.

## Inputs (`TokenStats`)

- `volumeByWallet` — cumulative USDC buy volume per wallet.
- `buys` — per-buy timestamps + amounts (used for time-decayed velocity).
- `liquidityDepthUsdc` — current LP base depth.
- `currentHolders` — wallets with positive balance now.
- `holdersAtRetentionAnchor` — wallets with positive balance at an earlier snapshot (e.g. 24h ago).

## Algorithm

```
composite = w_vel * normalize(volumeVelocity)
          + w_buy * normalize(uniqueBuyers)
          + w_liq * normalize(liquidityDepthUsdc)
          + w_ret * normalize(retention)
```

- **volumeVelocity** — sum of buy amounts with `2^(-age/halfLife)` decay (24h half-life by default), divided per-buy by `log2(1 + walletTotal/floor)` to dampen whales.
- **uniqueBuyers** — `sqrt(walletCount)` for diminishing returns.
- **liquidityDepth** — raw USDC depth; the most direct settlement-value proxy.
- **retention** — fraction of anchor-time holders still holding now.

Each component is min-max normalized across the cohort, then combined with the configured weights. Default weights: 40% velocity / 25% buyers / 20% depth / 15% retention.

## Tests

```sh
npm install
npm --workspace @filter-fun/scoring test
```

6 tests cover ranking-by-strength, whale dampening, time decay, retention sensitivity, empty cohort, and single-token cohort.

## Outstanding

- Cluster detection (group wallets funded by a common source) — placeholder; raw `volumeByWallet.size` is current proxy. Add when sybil signal is needed.
- Mission/event multipliers — apply on top of the composite; not implemented yet.
- Persisted scoring snapshots per phase (so Filter-day scores can be compared to Finals-day scores).
