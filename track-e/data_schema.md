# Track E — Input Data Schema

The pipeline expects a single CSV file with one row per token. Columns mirror what the indexer would compute at the spec's filter-equivalent timing (t+96h for filter.fun's locked cadence).

## Required columns

| Column | Type | Description |
|---|---|---|
| `token_address` | str | EVM token address, lowercase 0x... |
| `ticker` | str | Symbol (no $) |
| `chain` | str | `base`, `ethereum`, etc. |
| `platform` | str | Source launchpad: `clanker`, `bankr`, `liquid`, `filterfun`, etc. |
| `launch_ts` | int | Unix timestamp of token launch |
| `t_window_hours` | int | Hours from launch at which features are measured (default 96 for filter.fun cadence; 72 for legacy / other launchpads) |

## HP-component inputs (measured at `launch_ts + t_window_hours`)

These feed the 5 existing components + holderConcentration (per spec §6.4 + §41).

### Velocity inputs
| Column | Type | Description |
|---|---|---|
| `total_buy_volume_eth` | float | Cumulative buy-side ETH volume in window |
| `total_buy_volume_eth_decayed` | float | Same, weighted toward recent activity (exp decay; lambda=0.5/day). If unavailable, set equal to non-decayed. |

### Effective buyers inputs
| Column | Type | Description |
|---|---|---|
| `unique_buyers` | int | Distinct buyer wallet count |
| `buyer_volumes_eth_json` | str (JSON) | Per-wallet buy volume list, e.g. `"[0.5, 0.001, 12.4, ...]"`. Used for sqrt-dampening per spec §36.1.4. Required for accurate effectiveBuyers; if missing, fall back to `sqrt(unique_buyers) * (total_buy_volume_eth / unique_buyers)` heuristic. |

### Sticky liquidity inputs
| Column | Type | Description |
|---|---|---|
| `lp_depth_eth` | float | LP depth at end-of-window in ETH |
| `lp_removed_24h_eth` | float | Total LP removed in trailing 24h before end-of-window. Excludes protocol-controlled removals (filter events). |

### Retention inputs
| Column | Type | Description |
|---|---|---|
| `early_holders_count` | int | Distinct holders at t+24h |
| `early_holders_still_holding` | int | Subset of above still holding at end-of-window |

### Momentum inputs
| Column | Type | Description |
|---|---|---|
| `hp_delta_recent` | float | Rate-of-change of the 5-component raw HP between t+72h and t+96h: `(hp@96h − hp@72h) / max(hp@72h, ε)`, clipped to [−1, 1]. Pipeline.py applies the §6.4.5 cap when scoring. |
| `hp_trajectory_json` | str (JSON) | 5-component raw HP at `[t+24h, t+48h, t+72h, t+96h]` as a list of 4 floats, e.g. `"[2.586, 2.380, 2.357, 2.342]"`. Empty list `"[]"` for tokens with no swap activity. Computed in the fetcher with default §6.5 weights (renormalized to sum to 1.0 over the 5 non-momentum components). Useful for follow-up analyses of intra-window HP shape; not consumed by the v3 analysis pipeline. |

### Holder concentration inputs (per spec §41)
| Column | Type | Description |
|---|---|---|
| `holder_count` | int | Distinct holder count after excluding protocol/burn/pool addresses (per §41.3) |
| `holder_balances_json` | str (JSON) | Per-wallet balance list AFTER §41.3 filtering. E.g. `"[1000, 850, 432, ...]"`. Used to compute HHI. Required. |

## Outcome labels (measured at multiple horizons)

For each of three horizons (`30d`, `60d`, `90d`), four candidate labels per spec Track E roadmap:

| Column pattern | Type | Description |
|---|---|---|
| `outcome_{horizon}_holder_retention` | bool/int (0/1) | True if `current_holder_count > 0.5 * peak_holder_count` (still has meaningful holder base) |
| `outcome_{horizon}_price_floor` | bool/int (0/1) | True if `current_price >= 0.50 * peak_price` (≤50% drawdown from peak — v3 retune from 0.30 after v2 hit 100% True) |
| `outcome_{horizon}_volume_slope` | bool/int (0/1) | True if `7d_trailing_volume_at_horizon >= 0.01 ETH` (absolute weekly-volume floor — v3 retune from peak-relative 0.20 after v2 hit 0% True) |
| `outcome_{horizon}_composite` | bool/int (0/1) | All three above are True (strict "good token" definition) |

So twelve outcome columns total: 4 labels × 3 horizons. Plus the v3 primary outcome:

| Column | Type | Description |
|---|---|---|
| `survived_to_day_7` | bool/int (0/1) | True if at t+168h the token has `holder_count ≥ 5` AND `lp_depth_eth ≥ 0.5` AND any swap volume in the trailing 24h. On-chain only — no thresholds vs peaks. Closest retrospective proxy to "would have made the filter.fun h96 cut." |

## Optional metadata (helpful but not required)

| Column | Type | Description |
|---|---|---|
| `name` | str | Human-readable token name |
| `creator_address` | str | Launcher wallet |
| `notes` | str | Free-form notes for analyst |

## Example row (CSV)

```
token_address,ticker,chain,platform,launch_ts,t_window_hours,total_buy_volume_eth,total_buy_volume_eth_decayed,unique_buyers,buyer_volumes_eth_json,lp_depth_eth,lp_removed_24h_eth,early_holders_count,early_holders_still_holding,hp_delta_recent,holder_count,holder_balances_json,outcome_30d_holder_retention,outcome_30d_price_floor,outcome_30d_volume_slope,outcome_30d_composite,outcome_60d_holder_retention,outcome_60d_price_floor,outcome_60d_volume_slope,outcome_60d_composite,outcome_90d_holder_retention,outcome_90d_price_floor,outcome_90d_volume_slope,outcome_90d_composite,name,creator_address,notes
0xabc...,EXAMPLE,base,clanker,1714521600,96,12.4,8.2,142,"[0.5, 0.1, 2.3, ...]",4.5,0.2,89,71,0.05,124,"[1000, 850, ...]",1,1,0,0,1,0,0,0,0,0,0,0,Example Token,0xdef...,
```

## Data acquisition

Path 1 — Alchemy + competitor APIs (preferred for production Track E):
- Crawl `Token Deployed` / `Pool Created` events on launchpad factories
- For each launched token, replay swaps + LP add/remove + ERC-20 transfers in window
- Compute features at `launch_ts + 96h`
- Crawl forward to t+90d to compute outcome labels

Path 2 — Subgraph queries (faster, less granular):
- Use TheGraph subgraphs for each launchpad if available
- Pre-aggregated swap + holder data
- May lose per-wallet granularity needed for sqrt-dampening + HHI

Path 3 — Hybrid:
- Alchemy for the wallet-level granularity (effectiveBuyers, holder_balances_json)
- Subgraphs for aggregates (volumes, peak prices)

Whichever path: dump the resulting CSV at `track-e/corpus.csv` (or pass `--input` flag) and rerun the pipeline.

## Schema versioning

Bump `_schema_version` in pipeline.py if columns change. Existing real-data CSVs should explicitly declare their version in a leading comment row.
