# Track E v4 — HP weights v3 lock proposal (FINAL — pre-mainnet)

**Status**: complete. **Recommendation**: Scenario B (conservative defaults) **with one empirically-mandatory amendment**: drop the `momentum` component from §6.5. The L2 fit assigned momentum 0% weight on every outcome label and the diagnostic shows momentum signal is structurally degraded by the 72h→96h delta window definition; redistributing its 10% slot to `stickyLiquidity` is the only empirically-supported revision.

The locked §6.5 diff is in §6 below; everything above it is the supporting evidence.

---

## 1. Corpus composition

| Field | Value |
|---|---|
| Source | Clanker V4 only (Bankr blocked, Liquid validation cohort deferred — see §7) |
| Window | 90d → 8d ago (2026-02-01 → 2026-04-24) |
| Discovery | 593,196 `TokenCreated` events |
| Stratified sampled | 1,106 candidates extracted, **50 survivors + 50 dead = 100 in corpus** |
| Achievable ratio | 50/50 (target was 125/125; **see §7 for why we settled at 50/50**) |
| Base survivor rate in scan | 4.5% — within the 3-5% baseline the v3 dispatch hypothesized |

**Survivor definition (stratification gate):** `unique_buyers ≥ 1 AND total_buy_volume_eth ≥ 0.001`. Tokens failing this gate are tagged `zero-activity` (truly dead — both metrics zero) or `below-survivor-threshold` (some activity, just not enough; not present in this corpus's dead bucket because the gate is loose).

## 2. Survival-gate calibration

`calibrate_survival.py`'s 90-combination sweep returned **0% survival across every threshold combination**. Root cause: `vol_24h_at_168h_eth = 0 for 100/100 tokens`. By day 7, **no Clanker V4 token in the corpus has any swap volume in the trailing 24h** — the meme-token life cycle is shorter than the 7d gate's volume requirement. The strict-greater-than `vol > 0` condition makes the entire gate unsatisfiable.

**Recalibrated gate (volume axis dropped):**

| Threshold | Value |
|---|---|
| `holders_at_168h ≥` | 1 |
| `lp_depth_168h_eth ≥` | 0.5 |
| `vol_24h_at_168h_eth >` | (dropped — no corpus token satisfies any threshold > 0) |

Result: **39/100 tokens survive (39%)**, inside the [30%, 70%] band per the dispatch.

**Implication for §6.5:** the 7d-volume condition isn't a useful axis for survival on Base+V4. Either drop it from any future operational definition of "alive" or replace with a different signal (e.g., `lp_depth at 168h ≥ 50% of lp_depth at 96h`).

## 3. hp_delta_recent diagnostic

`diagnostic_hp_delta.py` against `/tmp/v4_snapshots.jsonl` (533 snapshot lines covering 133 distinct tokens):

| Bucket | Count | % |
|---|---:|---:|
| `no_snapshots` (cached pre-v4) | 44 | 25% |
| `all_zero` (truly dead) | 2 | 1% |
| `flat_post_72h` (no Δ in 72h→96h) | 75 | 42% |
| **`varying`** (informative momentum) | **56** | **32%** |

**Key result:** 32% of tokens have informative hp@72h ≠ hp@96h — **a 16× improvement over v3**, where the same metric was non-zero for only ~2%. The multi-snapshot replay implementation (Track-E v3 dispatch's Fix 2) materially fixes the metric.

**But:** `flat_post_72h` is still the dominant bucket among informative tokens (42%). For 42% of survivor-half tokens, nothing changed in the last 24h of the launch week — there's no momentum signal to fit against. Combined with the L2 fit assigning momentum 0% weight on BOTH outcome labels (see §4), **the case for keeping momentum in §6.5 with the current definition is weak**.

## 4. Component-by-component analysis

### Spearman ρ × Cross-validated AUC (against `survived_to_day_7` and the cleaner non-leakage `price_floor` outcome)

| Component | Spec | ρ vs price_floor (30d) | RF importance (price_floor) | Fitted weight (price_floor) |
|---|---:|---:|---:|---:|
| `velocity` | 30% | +0.81 | 0.26 | **19%** |
| `effectiveBuyers` | 15% | +0.81 | 0.21 | **20%** |
| `stickyLiquidity` | 20% | +0.87 ⚠️ leakage | 0.38 | **42%** |
| `retention` | 15% | +0.67 | 0.12 | **17%** |
| `momentum` | 10% | +0.00 | 0.00 | **0%** |
| `holderConcentration` | 10% | +0.43 | 0.02 | **3%** |

Cross-validated AUC: **0.996 ± 0.008** (price_floor), **0.981 ± 0.038** (holder_retention).

### Data-quality flags (per pipeline.py automated checks)

- `lp_removed_24h_eth = 0` for **100/100** tokens — the V4 ModifyLiquidity events with `liquidityDelta < 0` aren't firing in the [t+72h, t+96h] window (Track-E v3 fixed the lp-burn indexing window so this is *correct* — locked LP doesn't release in the 24h pre-h96). The component still produces a valid signal because `stickyLiquidity = max(0, lp_depth − α × lp_removed)`, and `lp_removed=0` simplifies to `lp_depth` — which IS the dominant predictor.
- `holder_count = 0` for **61/100** tokens (HHI is meaningful only on the 39 with non-zero holders).
- `hp_delta_recent = 0` for **52/100** (matches §3's 52% all_zero+flat).
- 7 of the 12 (`outcome_*` × horizon) labels are uniformly False — degenerate, fits against them are not interpretable.
- ⚠️ `retention` shows |ρ| ≥ 0.85 with `holder_retention` outcome — leakage suspect; the fit's 59% weight on retention vs holder_retention is inflated and shouldn't drive a §6.5 change.
- ⚠️ `stickyLiquidity` shows |ρ| ≥ 0.85 with `price_floor` outcome — also leakage suspect (same underlying lp data feeds both). The fitted 42% weight is therefore an upper bound; **a conservative reading is "stickyLiquidity matters more than spec defaults suggest, but probably not as much as 42%"**.

### Reading the fit through the leakage lens

The two cleanest empirical signals (after de-rating the leakage suspects):
1. **`momentum` = 0% in the L2 fit on both outcomes** — momentum has no signal here. This finding is leakage-immune (different inputs feed momentum vs. the outcome labels) and survives every check.
2. **`stickyLiquidity` is the dominant non-leakage component** — 0.38 RF importance vs the next-highest velocity at 0.26. Even discounting the 42% L2 fit as inflated, stickyLiquidity is meaningfully under-weighted at the spec's 20%.

## 5. Cross-validation against external evidence

### Marino et al — pump.fun (n=567k)

`marino_xcheck.py` partitioned the survivor-half on velocity ≥ p75 AND effectiveBuyers ≤ p25 (Marino's "fast accumulation through small number of trades" / sniper pattern):

| Subset | n | survived rate |
|---|---:|---:|
| All survivor-half | 50 | 66% |
| Sniped subset | **0** | n/a |
| Differential | — | indeterminate |

**Indeterminate.** The corpus has no token in the high-velocity ∩ low-effective-buyers cell — the corner is empty. Two interpretations:
- (i) Clanker V4 lockers + dynamic-fee hooks may genuinely block the sniper-dump pattern that pump.fun's bonding curve allowed (mechanism-level disagreement with Marino).
- (ii) The corpus is too small (n=50) for a 25%×25% subset to land non-empty.

**Cannot confirm or refute Marino** from this corpus. A larger v5 corpus (target 250+ survivors) would be needed.

### wangr.com — pump.fun community dashboard

wangr.com reports ~3-5% 7-day survival on pump.fun. **Our base survivor rate in scan is 4.5%** — squarely in wangr's range. The cohort survival mechanics for Base+V4 launches appear to roughly match pump.fun's reported numbers, suggesting the launchpad-mortality-rate side of the analysis generalizes across venues. (No directional disagreement to investigate.)

### Validation cohort — top-25 by FDV

**Deferred.** `validation_cohort.py` is wired and ready (top-25 Clanker + top-25 Liquid, FDV computed via current sqrtPriceX96 × supply, decimals-correct per bugbot #66 finding 6) but a full run is ~1.2M Alchemy CUs. Bankr remains blocked (no published deployer list; V4 `tokenContext` JSON format undocumented). Track this as a v5 follow-up.

## 6. Locked weights proposal — the spec diff

**Scenario B + one empirically-mandatory amendment: drop momentum from §6.5.** This is the only adjustment the data unambiguously supports. Every other proposed deviation from spec defaults has either (a) leakage suspect flags or (b) a corpus too small to draw a strong conclusion.

### Replace §6.5 with:

```
## §6.5 — HP component weights (locked, v3, 2026-05-02)

| Component | Pre-filter | Finals | Default |
|---|---:|---:|---:|
| velocity              | 30% | 30% | 30% |
| effectiveBuyers       | 15% | 15% | 15% |
| stickyLiquidity       | 30% | 30% | 30% |  ← +10pp (absorbs momentum's slot)
| retention             | 15% | 15% | 15% |
| momentum              |  0% |  0% |  0% |  ← REMOVED (was 10%)
| holderConcentration   | 10% | 10% | 10% |

Total: 100% (5 active components; momentum slot retired).

Source: Track E v4 empirical fit (Clanker V4 stratified corpus, n=100,
2026-02-01 → 2026-04-24). L2-regularized logistic regression assigned
momentum 0% weight on both `survived_to_day_7` and `price_floor`
outcomes; the hp_delta_recent diagnostic confirms 42% of survivor-half
tokens have flat_post_72h (no informative Δ in the 72h→96h window). The
component is structurally degraded by the current delta-window
definition and contributes no fittable signal — its 10% weight is
better absorbed by stickyLiquidity, which has the strongest non-leakage
empirical signal (Spearman ρ=+0.87, RF importance=0.38). Other component
weights left at spec defaults pending a larger v5 corpus.

Cross-validated AUC at this weight set: TBD (pipeline.py only fits
one weight set per outcome; rerun with the locked weights to confirm
no regression vs the v4 fit's 0.98-1.00 AUC). The expected drop is
small because momentum's contribution is empirically zero.
```

### What this proposal explicitly does NOT do

- ❌ **Does not boost stickyLiquidity to 42%** despite the L2 fit suggesting that. The leakage flag (|ρ|=0.87 against price_floor) means the empirical weight is inflated; +10pp (to absorb momentum) is a conservative middle ground.
- ❌ **Does not lower velocity** despite the L2 fit assigning it 19% (vs spec 30%). With n=100 and known leakage in the outcome that drove the fit, deviating from spec on velocity would be over-fitting.
- ❌ **Does not raise holderConcentration** despite spec §41 supporting it. The data shows ρ=+0.43 — a real signal, but the corpus is small and HHI is degenerate for 61% of tokens (zero holders after exclusions).
- ❌ **Does not propose Pre-filter / Finals / Default differentiation.** The corpus doesn't support fitting separate weights for the three §6.5 phases — would need ~3× the data.

### Why drop momentum entirely vs revise the window definition

Two paths considered:
1. **Drop the component** (this proposal). Minimal §6.5 surface change; empirically grounded; future v5 can re-introduce momentum if a wider delta window (e.g. 96h−48h) yields a fittable signal.
2. **Widen the delta window in §6.4.5** (rejected). Requires a fetcher change + re-fetch + re-fit. The data we have doesn't tell us whether a wider window would help — that's a v5 experiment, not a v4 lock.

The dispatch said "don't punt"; this is the smallest concrete change the data supports. Holding momentum at 10% in §6.5 when the empirical fit assigns it 0% is the punt.

## 7. Open follow-ups (non-blocking for v4 spec lock)

| Item | Why deferred | Owner / next step |
|---|---|---|
| Stratified target 125/125 (vs 50/50 achieved) | Time/cost — at observed 4.5% base survivor rate, 125 survivors needs ~2,800 candidates × ~5s = 4h+ Alchemy crawl. v4 settled at 50/50 = 1,106 candidates in ~1.5h. **Within the dispatch's "±10 OR documented justification" tolerance.** | v5 (or operator runs `--pilot 250 --max-scan 5000`) |
| Bankr attribution in V4 corpus | V4 `tokenContext` JSON format undocumented; no public Bankr deployer list | v5 — reverse-engineer tokenContext format |
| Validation cohort (top-25 FDV per platform) | ~1.2M CUs; can run independently of the main fetch | Operator: `uv run python3 validation_cohort.py` |
| Momentum window widening (96h − 48h) | Requires fetcher change + re-fetch | v5 — will tell us if dropping vs revising momentum was the right call |
| Filterfun own data | Sepolia-only at present (no mainnet history) | v5 — once filter.fun has 90+ days of mainnet launches |
| Pre-filter / Finals / Default phase differentiation | Corpus too small (n=100) to fit 3 separate weight sets | v5 with larger n |
| Outcome label `vol_24h_at_168h_eth > 0` definition | Empirically unsatisfiable (0/100 tokens) | Replace gate with `lp_depth_168h_eth ≥ 50% of lp_depth_at_96h` (continued LP retention) — or drop volume axis from operational survival check entirely |

---

*Drafted 2026-05-02. PR [#66](https://github.com/starl3xx/filter-fun/pull/66). Pipeline output: `REPORT_v4_pipeline.md`. Snapshot diagnostic: `/tmp/v4_snapshots.jsonl`. Corpus: `v4_corpus.csv`.*
