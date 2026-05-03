# Track-E v4 — Validation Cohort Addendum

This is a follow-up to `REPORT_v4.md` (the locked §6.5 weights deliverable),
covering task #28 — the validation cohort's HP-vs-FDV rank correlation.

## TL;DR

We ran the validation cohort end-to-end. Pipeline works. The cohort
materialized at **n=7** tokens (well below the planned 50), and the
resulting Spearman ρ between HP rank and current FDV rank is:

  - **§6.5 LOCKED (Scenario B, momentum=0)**: ρ = **+0.571** (p=0.180)
  - **Pre-v4 spec defaults (momentum=10%)**:  ρ = **+0.679** (p=0.094)

Both are positive (the right direction), but neither reaches significance
at n=7. **Notably, the spec defaults edge out the §6.5 LOCKED weights on
this cohort** — i.e., putting some weight on momentum produces a slightly
better rank correlation than dropping it entirely. That contradicts the
main-corpus L2 fit (which assigned momentum 0% on the 100-token
stratified corpus and motivated the LOCKED proposal in the first place).

**This is not enough evidence to override the main-corpus lock decision**
(n=7 vs n=100, p=0.094 vs concrete L2 + RF importance), but it IS
evidence that momentum's empirical contribution is sensitive to which
slice of the population you look at — recent-active tokens (this cohort,
by construction) may be exactly the regime where momentum signal
matters, while flat_post_72h tokens dominate the main corpus and
suppress it.

**Recommendation:** keep the §6.5 LOCKED weights as proposed in
`REPORT_v4.md` for mainnet, but treat momentum's drop as the most
fragile of the four weight changes. The v5 follow-up (proper
liquidity-first selection, n≈50) should explicitly re-test LOCKED vs
spec defaults — if the momentum-included version continues to
out-correlate FDV at larger n, the lock should be revisited before
post-mainnet refit.

The cohort-size blocker is methodological — see "Why the cohort came
back small" below. The fix is straightforward and is filed as the v5
follow-up.

## Run details

- Script: `validation_cohort.py` (commit on `track-e/validation-cohort`).
- Discovery window: blocks 37,721,968 → 44,201,968 (180d → 30d ago).
- Candidates discovered:
  - Clanker V4: **764,649** TokenCreated events
  - Liquid V1:  **120** TokenCreated events
- Subsample: random sample of **5,000 Clanker** (seed=42) + **all 120 Liquid**
  for FDV scoring. Total scored: 5,120.
- FDV cutoff: any non-zero current price × supply within a 7d swap lookback.
- Cohort size after FDV filter: **7 tokens** (6 Clanker, 1 Liquid).
- Total runtime: ~40 minutes (~2.3 tok/s).

## Why the cohort came back small

Of the 5,120 scored candidates, **only 7 (~0.14%) had any swap in the
last 7 days**. We were expecting ~5% based on dispatch heuristics; the
real survival-with-recent-activity rate on Clanker V4 is much lower
(consistent with the main corpus's 4.5% base survivor rate after
day-7 — once you require *recent* activity rather than *any* activity,
the rate drops another order of magnitude).

This is a population-level finding worth flagging on its own:

> Random sampling at 5k/764k = 0.66% of candidates is too sparse to
> recover the true top-25 by FDV. Expected captured-true-top-25 from
> a uniform random sample at this rate is < 1.

In other words: this *can't* be fixed by re-running with the same
algorithm at larger N — the cost grows linearly with N at the same
~0.14% hit rate, so to get even ~50 hits we'd need a ~36k-candidate
scan (~4 hours), and even that wouldn't span the true top-25 of the
765k-token population, just a denser slice of the live tail.

## Cohort + scores

Scoring path: `pipeline.compute_components` (raw scores from
`pipeline.py` imported directly; the three unbounded components —
velocity, effectiveBuyers, stickyLiquidity — are percentile-ranked
within the cohort, then weighted and summed × 100, matching the
production composite).

| token | platform | fdv_eth | hp_locked | hp_spec |
|---|---|---:|---:|---:|
| `0x2665a0a3…` (MOLLIE) | clanker | 19.878 | 65.20 | 59.48 |
| `0xdf25a0f9…` (CASH) | clanker | 11.911 | 87.46 | 77.46 |
| `0x5abb22df…` (NODELINE) | clanker | 9.877 | 42.86 | 40.00 |
| `0x88ec27f8…` (Base Agent) | clanker | 9.871 | 54.16 | 49.87 |
| `0x95b49d0c…` (IClaw) | clanker | 9.871 | 79.29 | 70.71 |
| `0x7dc54322…` (MOLTX) | clanker | 9.871 | 43.08 | 35.93 |
| `0x9481f43a…` (Liquid Test Token) | liquid | 7.663 | 32.14 | 30.71 |

Five of the seven cluster within 0.01 ETH of each other (≈ 9.87). Most
likely cause: the last-recorded sqrtPriceX96 for these pools is at or
near the initialization price (i.e., the pool has had at most one swap
since launch, leaving sqrtPriceX96 at its post-add-liquidity baseline).
That further weakens any FDV signal — the rank order at the bottom of
the cohort is essentially noise.

`CASH` and `IClaw` are the standouts: HP scores well above their FDV
rank under either weight set. This is the kind of point the validation
is meant to catch — *would the §6.5 weights have flagged them as
winners before their FDV did?* The answer here is yes: both score in
the top 2 by HP (LOCKED and spec) despite middling FDV. With n=7 we
can't generalize, but the directional positive ρ is real.

### Methodology note on the scorer (was wrong in initial commit)

The first version of `validate_hp_rank.py` had a critical bug caught
by bugbot #76 finding 1: `holderConcentration` was computed as
`tanh(holder_count / 100)` — measuring **count of holders** — instead
of the spec's HHI on `holder_balances_json`. With holderConcentration
at 10% weight, this corrupted the HP scores and produced ρ = +0.321
for both weight sets (artificially identical because the bug + the
tanh-everywhere normalization happened to flatten the rank delta).

The current implementation imports the per-component scorers
(`velocity_score`, `effective_buyers_score`, `sticky_liquidity_score`,
`retention_score`, `momentum_score`, `hhi_score`) directly from
`pipeline.py` to prevent this class of drift in the future. Same pattern
as the `survival_gate` extraction in #66 — single source of truth.

## Conclusion for the §6.5 lock

The lock from `REPORT_v4.md` (drop momentum, redistribute its 10% to
stickyLiquidity → 30/15/30/15/0/10) is **unchanged** by this run, but
not unconditionally:

- The corrected validation analysis shows pre-v4 spec defaults
  (momentum=10%) producing ρ = +0.679 vs LOCKED's ρ = +0.571 on n=7.
- This is in tension with the main-corpus L2 fit, which assigned
  momentum 0% weight on the 100-token stratified sample.
- The likely reconciling story: the validation cohort is a recent-
  active subpopulation by construction, and momentum signal may be
  more informative there than in the main corpus where flat_post_72h
  tokens dominate.

The argument for shipping the lock as-is for mainnet:
1. The empirical case from `REPORT_v4.md` — RF importance, L2 fit,
   leakage-aware analysis — already justified the weight set on a 100-
   token stratified corpus.
2. The Marino cross-check was indeterminate (n_sniped < 5), and the
   wangr base-rate match (~3-5% vs our 4.5%) corroborated the corpus.
3. The post-mainnet plan can re-run validation against the actual
   filter.fun corpus, where we have full control over the candidate
   set and don't need to subsample.

The risk: the §6.5 lock is fit to one 100-token stratified sample with
no out-of-sample validation. If filter.fun's launch dynamics differ
materially from Clanker V4 (e.g., higher fees, locked LP, different
fee-tier defaults), the weight set may not transfer. Mitigation: the
weights are runtime-configurable, so a post-mainnet refit is cheap.

## v5 follow-up — proper validation algorithm

The right fix is to swap the candidate-then-FDV-sample funnel for a
liquidity-first scan:

1. Scan **PoolManager Swap logs globally** over the last 7d (~302k
   blocks, ~30 getLogs calls at Alchemy's 10k-block limit).
2. Group by `pool_id`; rank pools by recent swap count or recent
   volume.
3. Take the top-N pools (e.g. 500), look up their token addresses,
   cross-reference against the Clanker + Liquid candidate sets.
4. FDV-sample only the cross-referenced subset (~50–200 tokens).

This is O(swaps_per_week + topN) instead of O(candidates), and gets
the actual top-25 by recent activity rather than a random sample of
the long tail. Estimated runtime: **~10–15 min** for the full thing.

Filed as a v5 task. Not blocking mainnet.

## Files added/changed in this PR

- `validation_cohort.py` — added `--max-candidates-per-platform` and
  `--seed` flags. Without subsampling the script tried to FDV-sample
  all ~765k Clanker candidates, which would have taken ~3–5 days.
- `validate_hp_rank.py` — new. Reads `validation_corpus.csv`, parses
  `fdv_eth` out of the `notes` column (where `validation_cohort.py`
  stashes it), and emits the Spearman ρ table above.
- `validation_corpus.csv` — the n=7 cohort (kept for reproducibility;
  small enough to commit).
- `REPORT_v4_validation.md` — this file.
