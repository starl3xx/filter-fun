# Track E — HP Empirical Validation

This folder is the standalone implementation of Track E (HP weights v3 empirical validation, per spec §6 + §41 + ROADMAP.md Track E).

## What's here

| File | What |
|---|---|
| `pipeline.py` | The full analysis pipeline. Computes HP components, runs correlations + RandomForest importance + L2 logistic regression weight fitting + rank-stability counter-test. Renders a markdown report. |
| `fetch_corpus.py` | Real-data corpus fetcher. Crawls Clanker V4 launches on Base mainnet via Alchemy, extracts HP-component inputs at t+96h, forward-replays for outcome labels at 30/60/90d. Idempotent + checkpointed. |
| `sources.md` | Authoritative reference for every factory address, event signature, and pool dependency the fetcher reads. Basescan-linked, reproducible. |
| `data_schema.md` | Required column format for input CSV. Maps to spec data fields + outcome labels. |
| `pyproject.toml` | uv-managed Python deps for both pipeline + fetcher. |
| `synthetic_corpus.csv` | 500 synthetic tokens with realistic distributions. Generated deterministically (seed=42). For demo / pipeline testing only. |
| `SYNTHETIC_DEMO_REPORT.md` | The pipeline's output on synthetic data. **Numbers are not real findings — see warning at top of file.** |

## What this is for

Spec §6 + §41 propose a 6-component HP scoring system with starting weights (30/15/20/15/10/10 default). Track E exists to either confirm or revise those weights using historical data from comparable launchpads (Clanker / Bankr / Liquid). Output is a "HP weights v3" report that locks the weights before Phase 2 mainnet.

The pipeline works in three stages:

1. **Compute** — given a corpus CSV, compute all 6 HP components per token at the spec's filter-equivalent timing (t+96h)
2. **Analyze** — correlate each component with each outcome label across three horizons (30d / 60d / 90d), then re-fit weights via regularized regression, then counter-test by comparing rank stability between weight sets
3. **Report** — generate a markdown report with the findings, ready to inform the §6.5 weight lock

## Running on synthetic data (instant, no setup)

```sh
cd track-e
python3 pipeline.py
```

Generates `synthetic_corpus.csv` (500 tokens, deterministic) and writes `SYNTHETIC_DEMO_REPORT.md`. Useful for verifying the pipeline mechanics work end-to-end. **Numbers are made up.**

## Running on real data (the actual deliverable)

1. **Set the Alchemy Base mainnet endpoint** (gitignored — never commit this file):
   ```sh
   echo 'BASE_MAINNET_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<your-key>' \
       > track-e/.env
   ```

2. **Install deps via uv:**
   ```sh
   cd track-e && uv sync
   ```

3. **Run a pilot** (50 tokens, ~5–10 minutes, ~5–10M Alchemy CUs):
   ```sh
   uv run python3 fetch_corpus.py --pilot 50
   ```

4. **Validate against the analysis pipeline:**
   ```sh
   uv run python3 pipeline.py --input corpus.csv --output REPORT.md
   ```

5. **Run the full crawl** (target 500–2000 tokens, multi-hour, ~hundreds of millions of CUs):
   ```sh
   uv run python3 fetch_corpus.py
   ```
   The fetcher is checkpointed (`.fetch_state.json`) — interruptions resume cleanly.

6. **Read the report.** The recommendation section uses heuristics on the analysis results to surface candidates for weight changes; treat as a starting point for human judgment, not a final answer.

### Coverage of the v1 fetcher

| Source | Status |
|---|---|
| Clanker V4 (`0xE85A…83a9`) | ✅ Active in target window — primary corpus source. |
| Clanker V1–V3.5 | ⏸ Dormant in 6mo→90d-ago window (zero events; verified in `sources.md`). Not crawled. |
| Bankr | ⏸ Factory address not located in public docs. Skipped. |
| Liquid | ⏸ Identification ambiguous (LiquidLaunch is on Hyperliquid, not Base). Skipped. |
| Filterfun (own) | ⏸ Sepolia-only — insufficient mainnet history. Add in v2. |

Clanker V4 alone yields ~5,978 TokenCreated events per 200k Base blocks (~120k+ tokens in the 6-mo window), so the corpus target is comfortably reachable from this single source.

### Cost estimate (per token)

| Step | RPC calls | CUs |
|---|---|---|
| Discovery (one-time across full window) | ~155 | ~12k |
| Swap-event crawl (PoolManager filtered by poolId, launch → launch+90d) | ~78 | ~5.85k |
| ModifyLiquidity crawl (72-96h window) | ~5 | ~375 |
| Transfer-event crawl (token, launch → launch+90d) | ~78 | ~5.85k |
| `decimals()` + per-block-timestamp + assorted | ~5 | <1k |
| **Per-token total** | **~166** | **~12k** |

For a 500-token corpus: ~6M CU. For 2000 tokens: ~24M CU. Wash-traded or hyper-active pools may 2–3× cost via auto-chunking on log-limit retries.

## Pipeline details (per spec)

### HP components implemented

| Component | Spec § | Formula sketch |
|---|---|---|
| velocity | §6.4.1 | total_buy_volume_eth_decayed (or non-decayed fallback); percentile-ranked across corpus |
| effectiveBuyers | §6.4.2 + §36.1.4 | sum(sqrt(walletBuyVolume)) per spec sqrt-dampening; percentile-ranked |
| stickyLiquidity | §6.4.3 + §36.1.4 | max(0, lp_depth - α × lp_removed_24h), α=1.0; percentile-ranked |
| retention | §6.4.4 | early_holders_still_holding / early_holders_count |
| momentum | §6.4.5 | hp_delta_recent capped at 0.10 (per PR #31's pattern) |
| holderConcentration | §41.4 | HHI = 10000 × Σ(p_i²); mapped via 1 − log10(max(HHI,1)) / log10(10000) |

Address filtering for HHI (per spec §41.3) is assumed to happen during corpus construction — the JSON balance lists in the CSV should already exclude protocol contracts, burn addresses, V4 pool addresses.

### Analysis methods

- **Correlation**: Spearman ρ (rank-based, robust to outliers) + ROC AUC
- **Feature importance**: RandomForest (200 trees) per outcome label, averaged across horizons
- **Weight fitting**: L2-regularized logistic regression on standardized components; coefficients clipped to non-negative; normalized to sum to 1.0
- **Counter-test**: Spearman rank correlation between HP rankings under two weight sets
- **Cross-validation**: 5-fold stratified, mean ± std AUC

### Outcome labels (4 candidates × 3 horizons = 12 total)

Per spec Track E roadmap section:

- `outcome_{horizon}_holder_retention` — still has >N holders at horizon
- `outcome_{horizon}_price_floor` — price ≥ X% of peak at horizon
- `outcome_{horizon}_volume_slope` — weekly volume above floor at horizon
- `outcome_{horizon}_composite` — all three above true (strict definition)

Horizons: 30d, 60d, 90d.

## What the synthetic demo proves

- Pipeline runs end-to-end without errors
- Component computation matches spec (HHI math, sqrt-dampening, retention ratio, etc.)
- Correlation analysis produces sensible numbers (retention is the strongest predictor in the synthetic data, which makes sense given how the synthetic outcomes were generated)
- Weight fitting converges and produces non-negative weights summing to 1
- Cross-validated AUC is reasonable (0.85–0.91 on synthetic — high because the synthetic data has clean signal)
- Rank stability metric works (current 5-comp vs candidate 6-comp = 0.996 rank correlation, since the 6th component is added with a small weight)

These are mechanical proofs that the pipeline is correct. They tell you NOTHING about real-world filter.fun weights.

## Known limitations of the v1 corpus

1. **Clanker V4 only.** Bankr and Liquid factories aren't crawled (see `sources.md` for why). Clanker dominates Base launchpad volume so the corpus is representative of Base meme-token launches but not exhaustive across launchpads.
2. **`lp_depth_eth` is approximated.** V4 PoolManager holds currency totals across all pools (no per-pool reserve to read directly). The fetcher uses cumulative net WETH inflow via swaps in the launch→t+96h window as a proxy. Directional comparison across tokens is fine; absolute values are not literal pool balances.
3. **`lp_removed_24h_eth` is approximated.** Derived from `ModifyLiquidity` events with `liquidityDelta < 0` in the 72-96h window, with WETH-side amount estimated from `liquidity × sqrtPriceX96 / 2^96` (full-range approximation).
4. **Outcome labels use weekly sampling.** Peak metrics (`peak_holder_count`, `peak_price`, `peak_7d_volume`) are computed from weekly snapshots rather than block-by-block. Trades ~700× RPC-cost reduction for ~5% noise on outcome labels.
5. **Wash-traded pools are NOT excluded.** Including them tests HP scoring's sqrt-dampening robustness; it's a feature, not a bug. If you need a wash-filtered corpus for a specific analysis, add a post-processing pass.

## What's NOT here yet

- Bankr / Liquid factory inclusion (factories not located — see `sources.md`)
- Per-pool exact LP depth via V4 StateView lens (proxy used instead)
- Time-series analysis (pipeline is point-in-time at t+96h; spec doesn't require time-series)
- HP weight stress-testing under adversarial inputs (Track B sims cover this)
- Filterfun own data (Sepolia-only at present)

## Integration with the rest of the project

- Spec source of truth: `/Users/jakebouma/Documents/Claude/Projects/filter.fun/filter_fun_comprehensive_spec.md` §6 + §41
- Implementation reference: `packages/scoring/` in the main filter-fun repo (PR #31 shipped HP v3, PR #32 shipped backtest harness, PR #45 enriched indexer with holder snapshots)
- Roadmap: Track E in `ROADMAP.md` — execution status updates here
- Once a real-data report exists, update spec §6.5 with the locked weights

## Data acquisition decision

**Decision: Path 1 — Alchemy + custom crawler.** Implemented in `fetch_corpus.py`.

Trade-offs that drove the choice:
- The HP analysis needs per-wallet buy volumes (sqrt-dampening per spec §36.1.4) and per-wallet token balances (HHI per spec §41), which subgraphs typically pre-aggregate away.
- Alchemy's `eth_getLogs` gives full-fidelity event history at block precision — required for the t+24h vs. t+96h holder snapshot comparison.
- Subgraph dependency adds external availability risk for a one-shot historical fetch.

Path 3 (hybrid) was rejected because the wallet-level data needed for HHI + effectiveBuyers can't come from subgraphs anyway — the Alchemy crawl is the critical path either way.
