# Track-E v5 — Formula-Lock Refit (Epic 1.22)

**Refit date:** 2026-05-04
**Spec lock:** §6.4.x + §6.7 (formulas + fixed-reference normalization), 2026-05-04
**Engine version under test:** `HP_WEIGHTS_VERSION = "2026-05-04-v4-locked-int10k-formulas"`
**Cohort:** `validation_corpus_v5_topn50.csv` — 43 tokens, top-50/platform liquidity-first scan (unchanged from `REPORT_v5_validation.md`)

> **Status: ✅ Locked formulas reproduce v5 validation, with a meaningful improvement.**
> Under the Epic 1.22 fixed-reference normalization (§6.7), HP vs FDV
> Spearman ρ = **+0.4212 (p=0.0049)** at n=43 — comfortably above the dispatch's
> tolerance band (`+0.36 ± 0.10`) and **+0.057 above the pre-lock baseline** of
> +0.3644. The cohort-percentile normalization that v5 originally validated
> is reproducible behind the `compute_components_legacy_percentile` path so
> the diff is mechanically auditable.

---

## 1. Methodology — what changed since v5

`REPORT_v5_validation.md` validated the §6.5 LOCKED weight set against the
top-50/platform v5 cohort under **percentile-rank normalization** (the
pre-lock convention: `df.rank(pct=True)`). The Epic 1.22 spec amendment
(§6.7) replaces percentile rank with **fixed-reference normalization**:

```
component_score = clip(raw_value / *_REFERENCE, 0, 1)
```

where each `*_REFERENCE` is calibrated from the v5 cohort 90th percentile.
The four formula sections (§6.4.1 velocity, §6.4.2 effective-buyers,
§6.4.3 sticky-liquidity, §6.4.4 retention) themselves are now
constants-driven (no magic numbers in formula bodies); see
`packages/scoring/src/constants.ts` for the locked values.

This refit re-runs the v5 cohort under the locked formulas + fixed-reference
normalization and asks: **does the rank-correlation finding survive the
normalization mode change?** The dispatch's tolerance band is `+0.36 ± 0.10`
— anything outside that band would mean the refactor changed scoring
behavior in unintended ways.

## 2. Reference calibration

90th-percentile values from the n=43 cohort (computed by the same component
helpers as the engine — see `pipeline.compute_components`):

| Component        | p50         | p90 (locked REFERENCE) | max         |
|------------------|------------:|----------------------:|------------:|
| velocity         | 122.335     | **1115.451** WETH     | 11,494.502  |
| effectiveBuyers  | 60.637      | **191.129**           | 503.984     |
| stickyLiquidity  | 32.454      | **67.275** WETH       | 598.383     |

These values are baked into `packages/scoring/src/constants.ts` as
`VELOCITY_REFERENCE`, `EFFECTIVE_BUYERS_REFERENCE`, `STICKY_LIQUIDITY_REFERENCE`.
A future re-calibration requires repeating this refit and verifying ρ stays
in the tolerance band; the operator runbook (Epic 1.7, §parameter-changes)
treats these constants identically to weight changes (≥7-day public notice).

## 3. Results — Spearman ρ vs FDV (n=43)

| Normalization mode | Spearman ρ | p-value | Δρ vs legacy |
|---|---:|---:|---:|
| **Fixed-reference (Epic 1.22 lock)** | **+0.4212** | **0.0049** | **+0.0568** |
| Legacy percentile (pre-1.22, v5 baseline) | +0.3644 | 0.0163 | — |

**Both pass at α=0.05.** The locked formulas produce a *stronger* rank
correlation than the pre-lock percentile path, by a meaningful margin —
neither just-passes nor regresses.

### Per-component contribution (fixed-reference)

| Component | comp_score ρ vs FDV |
|---|---:|
| velocity | +0.3966 |
| effectiveBuyers | +0.3224 |
| stickyLiquidity | +0.2516 |
| retention | (not tested individually — already in [0,1]) |
| holderConcentration | (not tested individually — HHI mapping unchanged) |

Velocity is the strongest single signal — consistent with §6.5's 30% weight
allocation. Sticky-liquidity is the weakest of the three reference-normalized
components but still positive; together with retention's binary
intersection signal this composes to the +0.42 composite.

## 4. HP distribution shape

| Mode | min HP | median | max HP |
|---|---:|---:|---:|
| Fixed-reference | 1558 | 3978 | 8801 |
| Legacy percentile | 1919 | 5309 | 8801 |

Fixed-reference compresses the median downward (3978 vs 5309) — under
percentile rank, every cohort's median tends to settle around the middle
of the scale by construction; under fixed-reference the absolute floor is
visible. The shifts are exactly what §6.7's "absolute signal, not cohort
ranking" intent predicts: a weak cohort no longer mass-medians to 5000.

## 5. Tolerance gate

The dispatch specifies: **"ρ should remain in `+0.36 ± 0.10` band."**

Result: ρ = +0.4212 ∈ [+0.26, +0.46]. ✅ **Within band.**

Δρ from baseline = +0.0568. The shift is meaningful but mild — well within
the band's tolerance. No component-level investigation required; the
refactor preserves rank-discriminative power.

## 6. Caveats

1. **n=43 — same cohort size as v5.** The dispatch's tolerance band assumed
   the v5 cohort would be re-used; we do that here. A larger n=200+ cohort
   refit is filed as an Epic 2.X follow-up post-mainnet (per the
   `REPORT_v5_validation.md` v6 list).

2. **Reference values are v5-specific.** The 90th-percentile calibration
   reflects the v5 cohort's distribution. A future re-calibration against
   the actual filter.fun production data should rerun this refit + verify
   the band — see operator runbook §parameter-changes.

3. **Pre-mainnet refit only.** This validates that the locked engine
   reproduces the v5 validation under the new normalization mode. It is
   NOT a fresh empirical claim on filter.fun production data (which
   doesn't exist yet) — that work is post-launch.

## 7. Reproducing this refit

```sh
cd track-e
uv sync   # or: pip install -r requirements.txt

uv run python - <<'PY'
import sys, pandas as pd, re
sys.path.insert(0, '.')
from pipeline import compute_components, compute_components_legacy_percentile, composite_hp
from scipy.stats import spearmanr

LOCKED = {
    'velocity': 0.30, 'effectiveBuyers': 0.15, 'stickyLiquidity': 0.30,
    'retention': 0.15, 'momentum': 0.00, 'holderConcentration': 0.10,
}

df = pd.read_csv('validation_corpus_v5_topn50.csv')
fdv = df['notes'].apply(lambda s: float(re.search(r'fdv_eth=([0-9.]+)', s).group(1)) if isinstance(s, str) and 'fdv_eth=' in s else 0.0)

comp_locked = compute_components(df)
hp_locked = composite_hp(comp_locked, LOCKED)
rho, p = spearmanr(hp_locked, fdv)
print(f'Locked ρ = {rho:+.4f} (p={p:.4f}), n={len(df)}')
PY
```

Expected output:
```
Locked ρ = +0.4212 (p=0.0049), n=43
```

## 8. Decision

**Promote `HP_WEIGHTS_VERSION = "2026-05-04-v4-locked-int10k-formulas"` to
the active set,** following the §6.5 ≥7-day public-notice procedure
documented in `docs/scoring-weights.md` §5. The refit confirms the engine
matches spec on rank-discriminative power; activation does not require a
v6 follow-up cohort.
