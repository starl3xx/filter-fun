# Track E v4 — HP weights v3 lock proposal (FINAL — pre-mainnet)

> **Status**: scaffold. Auto-fill happens in the `## …` sections marked with
> `<<<FILL>>>` once `pipeline.py --input v4_corpus.csv --output REPORT.md` and
> `diagnostic_hp_delta.py --log /tmp/v4_snapshots.jsonl --corpus v4_corpus.csv`
> have run against the v4 stratified corpus + validation cohort.
>
> The "Locked weights" section at the bottom is the ONLY section that has to
> change in spec §6.5 — everything else is supporting evidence.

## Headline

<<<FILL: pick exactly one of the two scenarios below>>>

### Scenario A — clean fit (preferred)

We have ≥0.6 cross-validated AUC on `survived_to_day_7` (the on-chain primary
outcome) AND ≥3 components show |Spearman ρ| > 0.20 against it. Recommend
adopting the L2-fitted weights as §6.5's locked defaults, modulo
holderConcentration ≥ 0.05 floor (component is principled per spec §41
even if data is noisy).

### Scenario B — conservative defaults

Cross-validated AUC < 0.6 OR ≤2 components show meaningful correlation. The
empirical signal is too weak to overrule spec defaults; recommend keeping
§6.5's `30/15/20/15/10/10` weights with explicit caveats about
data-quality limitations and a follow-up Track E v5 once 90+ days of mainnet
filter.fun history exists (Filterfun is currently Sepolia-only).

---

## 1. Corpus composition

<<<FILL: pull from `## Corpus & data quality` section of REPORT.md>>>

- Total tokens: <N>
- Stratification: <N_survivors> survivors + <N_dead> dead (vs ±10 of pilot/2 each)
- Survivor rate observed in scan: <X%> of <N_scanned> candidates extracted
- Sources: Clanker V4 (primary, all rows), Liquid V1 (validation cohort only)

If the actual stratification is far from 50/50 (e.g. 40/60), document the
achievable-ratio justification: scanning more than --max-scan would have cost
>$X / >Y hours of Alchemy CUs. The dispatch's tolerance of ±10 is the bar.

## 2. Survival-gate calibration

<<<FILL: paste output of `calibrate_survival.py --input v4_corpus.csv`>>>

Recommended thresholds (loosest combo in [30%, 70%] band, applied via
`pipeline.py --survived-holders-min N --survived-lp-min-eth X --survived-vol-min-eth Y`):

| Threshold | Value | Source |
|---|---|---|
| holders_at_168h ≥ | <N> | empirical [30,70]% sweep |
| lp_depth_168h_eth ≥ | <X> | empirical [30,70]% sweep |
| vol_24h_at_168h_eth > | <Y> | empirical [30,70]% sweep |

Resulting `survived_to_day_7` true-rate on survivor half: <Z%> (target band [30%, 70%]).

## 3. hp_delta_recent diagnostic

<<<FILL: paste bucket distribution from `diagnostic_hp_delta.py`>>>

Bucket distribution from /tmp/v4_snapshots.jsonl:

| Bucket | Count | % |
|---|---:|---:|
| no_snapshots (cached pre-v4) | … | … |
| partial_<N> (extraction bailed) | … | … |
| all_zero (truly dead) | … | … |
| flat_post_72h (no Δ in last 24h) | … | … |
| varying (informative Δ) | … | … |

**If `varying` ≥ 30%** of the survivor half: momentum is fittable —
keep the §6.5 default `0.10` momentum weight.

**If `varying` < 30%**: momentum carries no signal in the current
72h→96h delta window. Either (a) widen the window to (96h − 48h) — needs
a fetcher change + re-fetch — or (b) drop momentum from §6.5 and
re-distribute its 0.10 weight across the other 5 components.

## 4. Component-by-component analysis

<<<FILL: copy the `## Per-component Spearman + AUC` table from REPORT.md>>>

| Component | Spec weight | ρ vs survived_to_day_7 | AUC | RF importance |
|---|---:|---:|---:|---:|
| velocity | 0.30 | … | … | … |
| effectiveBuyers | 0.15 | … | … | … |
| stickyLiquidity | 0.20 | … | … | … |
| retention | 0.15 | … | … | … |
| momentum | 0.10 | … | … | … |
| holderConcentration | 0.10 | … | … | … |

Flag components with |ρ| < 0.10 OR AUC < 0.55 — these are noise-dominated
in the current corpus and shouldn't drive a weight change away from spec.

## 5. Cross-validation against external evidence

### Marino et al — pump.fun (n=567k)

The closest published study to our corpus. Marino's strongest single
predictor was "fast accumulation of liquidity through small number of
trades" — i.e., a high-velocity launch with low effective buyers (a few
whales front-running). This maps to our `velocity` (high) × `effectiveBuyers`
(low). Cross-check: in our corpus, do tokens with high velocity AND
low effectiveBuyers have lower `survived_to_day_7` rate than the median?

<<<FILL: compute and report the conditional rate from v4_corpus.csv>>>

| Subset | survived_to_day_7 rate |
|---|---:|
| All survivor-half tokens | … |
| Velocity ≥ 75th pctile AND effectiveBuyers ≤ 25th pctile | … |
| Diff vs all (Marino predicts negative) | … |

### wangr.com — pump.fun community dashboard

Anecdotal cross-check: wangr typically reports survival rates of ~3-5%
at 7d on pump.fun. Our Clanker V4 dead-on-arrival rate (~95-97% from
pre-stratification scan) maps directly. If our calibrated 7d survival
rate on the survivor half is meaningfully different from wangr's
~3-5% on the full population, document why (filter-equivalent timing,
exclusion of non-WETH pairs, etc.).

### Validation cohort — top-25 Clanker + top-25 Liquid by FDV

<<<FILL: run validation cohort fetch + report HP-rank vs FDV-rank Spearman>>>

The cohort tests whether HP scoring places known winners at the top.
Spearman ρ between HP rank (with the proposed weights) and FDV rank:

| Platform | n | Spearman ρ |
|---|---:|---:|
| Clanker V4 (top-25 by FDV) | 25 | … |
| Liquid V1 (top-25 by FDV) | 25 | … |
| Combined | 50 | … |

ρ > 0.4 → strong validation. ρ < 0.2 → HP ranks don't reflect FDV; either
the weights are wrong OR FDV is dominated by exogenous factors (cult brand,
KOL boosts) that the on-chain data can't see. Either way, document.

## 6. Locked weights proposal — the spec diff

<<<FILL: pick A or B from the headline above, then write the literal
   replacement block for filter_fun_comprehensive_spec.md §6.5>>>

### Scenario A — replace §6.5 with:

```
## §6.5 — HP component weights (locked, v3, 2026-05-DD)

| Component | Pre-filter | Finals | Default |
|---|---:|---:|---:|
| velocity | <X1>% | <X2>% | <X3>% |
| effectiveBuyers | <Y1>% | <Y2>% | <Y3>% |
| stickyLiquidity | <Z1>% | <Z2>% | <Z3>% |
| retention | <W1>% | <W2>% | <W3>% |
| momentum | <M1>% | <M2>% | <M3>% |
| holderConcentration | <H1>% | <H2>% | <H3>% |

Source: Track E v4 empirical fit (250-token stratified Clanker V4 corpus,
2026-02-XX → 2026-04-XX), L2-regularized logistic regression against
`survived_to_day_7` primary outcome. AUC <A>±<B>, Spearman <ρ>±<σ>.
```

### Scenario B — replace §6.5 with:

```
## §6.5 — HP component weights (locked, v3, 2026-05-DD)

Spec §6.5 defaults retained pending v5 calibration:

| Component | Pre-filter | Finals | Default |
|---|---:|---:|---:|
| velocity | 30% | 30% | 30% |
| effectiveBuyers | 15% | 15% | 15% |
| stickyLiquidity | 20% | 20% | 20% |
| retention | 15% | 15% | 15% |
| momentum | 10% | 10% | 10% |
| holderConcentration | 10% | 10% | 10% |

Source: Track E v4 empirical analysis (250-token stratified Clanker V4
corpus, 2026-02-XX → 2026-04-XX) found <reason — e.g. AUC <0.6 on
survived_to_day_7, momentum 100% flat in 72h-96h delta window>. Empirical
signal too weak to overrule spec defaults. Re-evaluate in v5 once 90+
days of mainnet filter.fun history is available.
```

## 7. Open follow-ups (non-blocking for spec lock)

- **Bankr attribution**: V4 `tokenContext` JSON format still unparsed.
  Reverse-engineer + add `bankr_attributed: bool` column in v5.
- **Filterfun own data**: Sepolia-only at present; add to corpus once
  mainnet has 90+ days of production launches.
- **Momentum window widening**: if hp_delta_recent diagnostic shows
  flat_post_72h dominates, prototype (96h − 48h) delta in v5.
- **Per-pool exact LP depth via V4 StateView lens**: current proxy via
  cumulative WETH inflow is directionally correct but absolute values
  aren't literal pool reserves.
