#!/usr/bin/env python3
"""
Track E — HP empirical validation pipeline.

Per spec §6 + §41 + Track E roadmap. Runs against a CSV corpus matching
data_schema.md and produces a HP-weights-v3 report.

Usage:
    python3 pipeline.py [--input corpus.csv] [--output REPORT.md] [--seed 42]

Pure-Python, depends on: pandas, numpy, scikit-learn, scipy.
No network access required at analysis time.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

SCHEMA_VERSION = "1.0"

# Spec-locked starting weights per §6.5 default phase (with concentration as
# candidate 6th component per §41). Track E exists to either confirm or
# revise these numbers.
CURRENT_WEIGHTS_5 = {
    "velocity": 0.35,
    "effectiveBuyers": 0.20,
    "stickyLiquidity": 0.20,
    "retention": 0.15,
    "momentum": 0.10,
}

CANDIDATE_WEIGHTS_6 = {
    "velocity": 0.30,
    "effectiveBuyers": 0.15,
    "stickyLiquidity": 0.20,
    "retention": 0.15,
    "momentum": 0.10,
    "holderConcentration": 0.10,
}

COMPONENTS_6 = list(CANDIDATE_WEIGHTS_6.keys())

OUTCOME_HORIZONS = ["30d", "60d", "90d"]
OUTCOME_LABELS = ["holder_retention", "price_floor", "volume_slope", "composite"]


# ============================================================================
# HP component computation
# ============================================================================

def velocity_score(row: pd.Series) -> float:
    """
    Net buy inflow with decay weighting. Per spec §6.4.1.
    Normalized to 0-1 via percentile rank within corpus (caller handles).
    """
    decayed = float(row.get("total_buy_volume_eth_decayed", 0.0))
    raw = float(row.get("total_buy_volume_eth", 0.0))
    # Pre-rank: use decayed if available, else raw
    return decayed if decayed > 0 else raw


def effective_buyers_score(row: pd.Series) -> float:
    """
    sqrt-dampened economic significance per spec §6.4.2 + §36.1.4.
    effectiveBuyers = sum(sqrt(walletBuyVolume))
    """
    js = row.get("buyer_volumes_eth_json", "")
    if isinstance(js, str) and js.strip():
        try:
            volumes = json.loads(js)
            return float(sum(math.sqrt(max(0.0, v)) for v in volumes))
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
    # Fallback heuristic if per-wallet data unavailable
    n = int(row.get("unique_buyers", 0) or 0)
    total = float(row.get("total_buy_volume_eth", 0.0) or 0.0)
    if n <= 0 or total <= 0:
        return 0.0
    # Equal-distribution approximation of sum(sqrt(v_i)): n * sqrt(avg) = sqrt(n*total)
    avg = total / n
    return n * math.sqrt(avg)


def sticky_liquidity_score(row: pd.Series, alpha: float = 1.0) -> float:
    """
    LP depth penalized by recent withdrawals. Per spec §6.4.3 + §36.1.4.
    score = max(0, lp_depth - alpha * lp_removed_24h)
    """
    depth = float(row.get("lp_depth_eth", 0.0) or 0.0)
    removed = float(row.get("lp_removed_24h_eth", 0.0) or 0.0)
    return max(0.0, depth - alpha * removed)


def retention_score(row: pd.Series) -> float:
    """
    Fraction of early holders still holding. Per spec §6.4.4.
    Already 0-1.
    """
    early = int(row.get("early_holders_count", 0) or 0)
    still = int(row.get("early_holders_still_holding", 0) or 0)
    if early <= 0:
        return 0.0
    return min(1.0, still / early)


def momentum_score(row: pd.Series, cap: float = 0.10) -> float:
    """
    Recent HP delta, capped per spec §6.4.5 implementation (PR #31's pattern).
    Cap default is calibrated so momentum at max contributes ≤10 HP points
    to composite (i.e. raw value of 1.0 maps to cap × 100 = 10 HP).
    """
    raw = float(row.get("hp_delta_recent", 0.0) or 0.0)
    return max(0.0, min(cap, raw)) / cap  # normalize 0..1 within the cap


def hhi_score(row: pd.Series) -> float:
    """
    Holder concentration via HHI. Per spec §41.4 + §41.5.

    HHI = 10000 * sum(p_i^2) where p_i = balance_i / sum(balances)
    Mapping: score = 1 - log10(max(HHI,1)) / log10(10000)

    Reference points (spec §41.5):
      HHI 10000 (one holder) → 0.0
      HHI 1000              → 0.25
      HHI 100               → 0.50
      HHI 10                → 0.75
      HHI 1                 → 1.0
    """
    js = row.get("holder_balances_json", "")
    if not isinstance(js, str) or not js.strip():
        return 0.0
    try:
        balances = [float(b) for b in json.loads(js)]
    except (json.JSONDecodeError, TypeError, ValueError):
        return 0.0
    total = sum(balances)
    if total <= 0 or len(balances) == 0:
        return 0.0
    shares = [b / total for b in balances]
    hhi = 10000.0 * sum(s * s for s in shares)
    return max(0.0, min(1.0, 1.0 - math.log10(max(hhi, 1.0)) / math.log10(10000.0)))


def compute_components(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute all 6 HP components for every row. Returns a new DataFrame
    with `comp_<name>` columns. Each component is normalized to 0-1 via
    percentile rank within the corpus (so the composite makes sense).
    """
    raw = pd.DataFrame({
        "velocity_raw": df.apply(velocity_score, axis=1),
        "effectiveBuyers_raw": df.apply(effective_buyers_score, axis=1),
        "stickyLiquidity_raw": df.apply(sticky_liquidity_score, axis=1),
        "retention_raw": df.apply(retention_score, axis=1),
        "momentum_raw": df.apply(momentum_score, axis=1),
        "holderConcentration_raw": df.apply(hhi_score, axis=1),
    })

    # Normalize to 0-1 via percentile rank (corpus-relative).
    # retention, momentum, holderConcentration are already 0-1 by construction;
    # leave them as-is. velocity, effectiveBuyers, stickyLiquidity have
    # unbounded scales — percentile-rank normalize.
    out = pd.DataFrame(index=df.index)
    for comp in ["velocity", "effectiveBuyers", "stickyLiquidity"]:
        col = f"{comp}_raw"
        ranked = raw[col].rank(pct=True, method="average")
        out[f"comp_{comp}"] = ranked.fillna(0.0)
    for comp in ["retention", "momentum", "holderConcentration"]:
        out[f"comp_{comp}"] = raw[f"{comp}_raw"].clip(0.0, 1.0)
    # Keep raw values too for reporting
    for col in raw.columns:
        out[col] = raw[col]
    return out


def composite_hp(components_df: pd.DataFrame, weights: dict) -> pd.Series:
    """Linear combination of components × weights, scaled to integer HP.

    Epic 1.18 (spec §6.5): the canonical composite-HP scale is integer
    [0, 10000]. Same effective resolution as the prior float [0, 100]
    with two decimal places, but cleaner storage + alignment with the
    BPS convention used elsewhere in the protocol.

    Rounding mode: round-half-up via `int(value + 0.5)` for positives —
    matches the TypeScript scoring package's `Math.round` behavior so a
    Track E retrospective recompute lands on the same integer the
    indexer wrote on-chain. Python's default `round()` uses banker's
    rounding (4234.5 → 4234), which would diverge at exact half-points;
    we explicitly avoid it here.
    """
    total = pd.Series(0.0, index=components_df.index)
    for name, w in weights.items():
        col = f"comp_{name}"
        if col in components_df.columns:
            total = total + w * components_df[col]
    scaled = total.clip(0.0, 1.0) * 10000.0
    # `int(x + 0.5)` is round-half-up for non-negative x; matches Math.round in JS.
    return (scaled + 0.5).astype(int).clip(0, 10000)


# ============================================================================
# Analysis
# ============================================================================

@dataclass
class CorrelationResult:
    component: str
    label: str
    horizon: str
    spearman_rho: float
    spearman_p: float
    auc: float


def correlate_components_to_outcomes(
    components_df: pd.DataFrame,
    outcomes_df: pd.DataFrame,
) -> pd.DataFrame:
    """For each (component, outcome label) pair, compute Spearman rho + AUC."""
    rows = []
    for label in OUTCOME_LABELS:
        for horizon in OUTCOME_HORIZONS:
            col = f"outcome_{horizon}_{label}"
            if col not in outcomes_df.columns:
                continue
            y = outcomes_df[col].astype(int).to_numpy()
            if len(set(y)) < 2:  # need both classes for AUC
                continue
            for comp in COMPONENTS_6:
                x = components_df[f"comp_{comp}"].to_numpy()
                rho, p = spearmanr(x, y)
                try:
                    auc = roc_auc_score(y, x)
                except ValueError:
                    auc = float("nan")
                rows.append({
                    "component": comp,
                    "label": label,
                    "horizon": horizon,
                    "spearman_rho": rho if not math.isnan(rho) else 0.0,
                    "spearman_p": p if not math.isnan(p) else 1.0,
                    "auc": auc,
                })
    return pd.DataFrame(rows)


def feature_importance_per_label(
    components_df: pd.DataFrame,
    outcomes_df: pd.DataFrame,
    seed: int = 42,
) -> pd.DataFrame:
    """RandomForest feature importance per outcome label, averaged across horizons."""
    X = components_df[[f"comp_{c}" for c in COMPONENTS_6]].to_numpy()
    rows = []
    for label in OUTCOME_LABELS:
        importances_per_horizon = []
        for horizon in OUTCOME_HORIZONS:
            col = f"outcome_{horizon}_{label}"
            if col not in outcomes_df.columns:
                continue
            y = outcomes_df[col].astype(int).to_numpy()
            if len(set(y)) < 2:
                continue
            clf = RandomForestClassifier(
                n_estimators=200, random_state=seed, n_jobs=1, max_depth=None,
            )
            clf.fit(X, y)
            importances_per_horizon.append(clf.feature_importances_)
        if not importances_per_horizon:
            continue
        avg = np.mean(importances_per_horizon, axis=0)
        for i, comp in enumerate(COMPONENTS_6):
            rows.append({"label": label, "component": comp, "importance": float(avg[i])})
    return pd.DataFrame(rows)


def fit_weights_logreg(
    components_df: pd.DataFrame,
    outcomes_df: pd.DataFrame,
    target_label: str = "composite",
    target_horizon: str = "30d",
    C: float = 1.0,
    seed: int = 42,
) -> dict:
    """
    Fit L2-regularized logistic regression to derive empirical weights.
    Returns weights normalized to sum to 1.0.
    """
    col = f"outcome_{target_horizon}_{target_label}"
    if col not in outcomes_df.columns:
        return {}
    y = outcomes_df[col].astype(int).to_numpy()
    if len(set(y)) < 2:
        return {}
    X = components_df[[f"comp_{c}" for c in COMPONENTS_6]].to_numpy()
    scaler = StandardScaler()
    Xs = scaler.fit_transform(X)
    clf = LogisticRegression(C=C, penalty="l2", max_iter=2000, random_state=seed)
    clf.fit(Xs, y)
    coefs = clf.coef_[0]
    # Convert to non-negative weights summing to 1 (use softmax-style on positive part)
    pos = np.maximum(coefs, 0.0)
    if pos.sum() <= 0:
        # All-negative coefficients — fall back to uniform
        pos = np.ones_like(pos) / len(pos)
    weights_arr = pos / pos.sum()
    weights = {comp: float(weights_arr[i]) for i, comp in enumerate(COMPONENTS_6)}

    # CV uses a Pipeline so the scaler is re-fit within each fold (no leakage from
    # full-dataset statistics into test partitions).
    cv_pipeline = Pipeline([
        ("scaler", StandardScaler()),
        ("clf", LogisticRegression(C=C, penalty="l2", max_iter=2000, random_state=seed)),
    ])
    auc_scores = cross_val_score(
        cv_pipeline, X, y,
        cv=StratifiedKFold(n_splits=5, shuffle=True, random_state=seed),
        scoring="roc_auc",
    )
    weights["_cv_auc_mean"] = float(auc_scores.mean())
    weights["_cv_auc_std"] = float(auc_scores.std())
    return weights


def rank_stability(
    components_df: pd.DataFrame,
    weights_a: dict,
    weights_b: dict,
) -> float:
    """Spearman rank correlation between HP rankings under two weight sets."""
    hp_a = composite_hp(components_df, weights_a)
    hp_b = composite_hp(components_df, weights_b)
    rho, _ = spearmanr(hp_a, hp_b)
    return float(rho)


# ============================================================================
# Report generation
# ============================================================================

# Fields that drive the 6 HP components — used by the data-quality section to
# surface degenerate inputs before the reader looks at any findings that
# depend on them.
INPUT_FIELDS = [
    "total_buy_volume_eth",
    "total_buy_volume_eth_decayed",
    "unique_buyers",
    "buyer_volumes_eth_json",
    "lp_depth_eth",
    "lp_removed_24h_eth",
    "early_holders_count",
    "early_holders_still_holding",
    "hp_delta_recent",
    "holder_count",
    "holder_balances_json",
]

# Map each HP component to the raw input field whose same-name outcome
# would indicate input/outcome leakage if the Spearman correlation is high.
COMPONENT_TO_OUTCOME_LABEL = {
    "retention": "holder_retention",
    "velocity": "price_floor",
    "stickyLiquidity": "price_floor",
}


def _data_quality_section(df: pd.DataFrame, components_df: pd.DataFrame,
                          outcomes_df: pd.DataFrame) -> list[str]:
    """Build the Data Quality section. Surfaces degenerate fields BEFORE any
    finding depends on them. Flags >50% zero-rate inputs and any same-named
    input/outcome correlation above 0.85 (suggesting leakage)."""
    n = len(df)
    out: list[str] = ["## Data quality", ""]
    out.append(
        "Field-level non-zero rate, distribution stats, and outcome-label "
        "true-rates. Reading order matters: anomalies here invalidate findings "
        "below — components built on uniformly-zero inputs cannot be evaluated."
    )
    out.append("")
    out.append("| Field | % nonzero | % non-empty | Min | Median | Max | Notes |")
    out.append("|---|---:|---:|---:|---:|---:|---|")

    flags: list[str] = []
    for c in INPUT_FIELDS:
        if c not in df.columns:
            out.append(f"| `{c}` | n/a | n/a | n/a | n/a | n/a | column missing |")
            flags.append(f"input field `{c}` is missing from the corpus")
            continue
        if c.endswith("_json"):
            s = df[c].fillna("").astype(str)
            non_empty = (s.str.strip().str.len() > 2).sum()  # ignore "[]" and ""
            nz_pct = ne_pct = 100.0 * non_empty / max(n, 1)
            note = "JSON list of per-wallet balances/volumes"
            if non_empty < 0.5 * n:
                flags.append(
                    f"`{c}` is empty for {n - non_empty}/{n} tokens "
                    f"({100 * (n - non_empty) / max(n, 1):.0f}%)"
                )
            out.append(
                f"| `{c}` | {nz_pct:.0f}% | {ne_pct:.0f}% | n/a | n/a | n/a | {note} |"
            )
            continue
        col = pd.to_numeric(df[c], errors="coerce").fillna(0.0)
        nz = (col != 0).sum()
        nz_pct = 100.0 * nz / max(n, 1)
        ne_pct = nz_pct  # for numeric fields these are equivalent
        mn, md, mx = float(col.min()), float(col.median()), float(col.max())
        note = ""
        if nz < 0.5 * n:
            flags.append(
                f"`{c}` is zero for {n - nz}/{n} tokens "
                f"({100 * (n - nz) / max(n, 1):.0f}%) — components depending on "
                "this field will be uninformative"
            )
            note = "⚠️ majority zero"
        out.append(
            f"| `{c}` | {nz_pct:.0f}% | {ne_pct:.0f}% | {mn:.4g} | {md:.4g} | {mx:.4g} | {note} |"
        )

    out.append("")
    out.append("### Outcome label true-rates")
    out.append("")
    out.append("| Outcome | True | False | True rate |")
    out.append("|---|---:|---:|---:|")
    for h in OUTCOME_HORIZONS:
        for lab in OUTCOME_LABELS:
            col = f"outcome_{h}_{lab}"
            if col not in outcomes_df.columns:
                out.append(f"| `{col}` | — | — | column missing |")
                flags.append(f"outcome label `{col}` missing")
                continue
            t = int(outcomes_df[col].astype(int).sum())
            f_ = n - t
            rate = 100.0 * t / max(n, 1)
            out.append(f"| `{col}` | {t} | {f_} | {rate:.0f}% |")
            if t == 0 or t == n:
                flags.append(
                    f"`{col}` is uniformly {'True' if t == n else 'False'} — "
                    "any model fit against this label is degenerate"
                )
    # Track-E v3: survived_to_day_7 is the primary outcome label going forward
    # (on-chain only, no thresholds). Show it alongside the legacy 30/60/90d
    # × 4-label grid; it's not yet folded into the correlation/weight-fit
    # loops (deferred to a follow-up PR per the v3 dispatch's analysis-logic
    # constraint). pipeline.py's iteration over OUTCOME_HORIZONS × OUTCOME_LABELS
    # ignores it.
    if "survived_to_day_7" in df.columns:
        t = int(pd.to_numeric(df["survived_to_day_7"], errors="coerce").fillna(0).astype(int).sum())
        f_ = n - t
        rate = 100.0 * t / max(n, 1)
        out.append(f"| `survived_to_day_7` (primary, on-chain) | {t} | {f_} | {rate:.0f}% |")
        if t == 0 or t == n:
            flags.append(
                f"`survived_to_day_7` is uniformly {'True' if t == n else 'False'} — "
                "the primary outcome cannot be modeled"
            )

    # Same-name input/outcome leakage check: if the HP component built from a
    # raw field is near-perfectly Spearman-correlated with a similarly-named
    # outcome, the outcome may be implicitly derived from the same data.
    out.append("")
    out.append("### Input → same-name outcome leakage check")
    out.append("")
    out.append(
        "Spearman ρ between an HP component score and the like-named outcome "
        "label. ρ ≥ 0.85 across all horizons is a leakage signal: the "
        "outcome may be a deterministic function of the input rather than an "
        "independent quality measure."
    )
    out.append("")
    out.append("| Component | Outcome label | ρ@30d | ρ@60d | ρ@90d | Flag |")
    out.append("|---|---|---:|---:|---:|---|")
    for comp, lab in COMPONENT_TO_OUTCOME_LABEL.items():
        comp_col = f"comp_{comp}"
        if comp_col not in components_df.columns:
            continue
        rhos = []
        any_high = False
        for h in OUTCOME_HORIZONS:
            oc = f"outcome_{h}_{lab}"
            if oc not in outcomes_df.columns:
                rhos.append(("n/a", None))
                continue
            x = pd.to_numeric(components_df[comp_col], errors="coerce")
            y = pd.to_numeric(outcomes_df[oc], errors="coerce")
            mask = x.notna() & y.notna()
            if mask.sum() < 3 or x[mask].nunique() < 2 or y[mask].nunique() < 2:
                rhos.append(("n/a", None))
                continue
            from scipy.stats import spearmanr as _sr
            rho_val, _ = _sr(x[mask], y[mask])
            if rho_val is None or pd.isna(rho_val):
                rhos.append(("n/a", None))
                continue
            rhos.append((f"{rho_val:+.2f}", float(rho_val)))
            if abs(rho_val) >= 0.85:
                any_high = True
        flag_cell = "⚠️ leakage suspect" if any_high else ""
        if any_high:
            flags.append(
                f"component `{comp}` shows |ρ| ≥ 0.85 with outcome `{lab}` "
                "across at least one horizon — verify the outcome is not derived "
                "from the same field"
            )
        out.append(
            f"| `{comp}` | `{lab}` | {rhos[0][0]} | {rhos[1][0]} | {rhos[2][0]} | {flag_cell} |"
        )

    out.append("")
    if flags:
        out.append("### Flags")
        out.append("")
        for f_ in flags:
            out.append(f"- {f_}")
        out.append("")
        out.append(
            "_If any flag fires, treat the corresponding correlation/weight-fit "
            "results below as unreliable and discard them from the recommendation._"
        )
    else:
        out.append("_No data-quality flags raised._")
    out.append("")
    return out


def render_report(
    df: pd.DataFrame,
    components_df: pd.DataFrame,
    outcomes_df: pd.DataFrame,
    correlations: pd.DataFrame,
    importances: pd.DataFrame,
    fitted_weights_per_label: dict,
    rank_stabilities: dict,
    is_synthetic: bool,
    seed: int,
) -> str:
    """Generate a markdown report."""
    n_tokens = len(df)
    platform_breakdown = df["platform"].value_counts() if "platform" in df.columns else pd.Series(dtype=int)

    out = []
    if is_synthetic:
        out.append("# HP Weights v3 — Track E Synthetic Demonstration")
        out.append("")
        out.append("> ⚠️ **THIS REPORT USES SYNTHETIC DATA. NOT REAL FINDINGS.**")
        out.append(">")
        out.append("> Numbers below come from a generated corpus designed to demonstrate the")
        out.append("> pipeline. They show *what the analysis would produce*, not what filter.fun")
        out.append("> should adopt as production weights. Real Track E analysis requires running")
        out.append("> this same pipeline against a corpus pulled from Clanker / Bankr / Liquid")
        out.append("> via Alchemy or similar.")
        out.append("")
    else:
        out.append("# HP Weights v3 — Empirical Validation")
        out.append("")

    out.append(f"_Generated by `pipeline.py` (schema v{SCHEMA_VERSION}, seed={seed})_")
    out.append("")
    out.append("## Corpus")
    out.append("")
    out.append(f"- **Tokens analyzed:** {n_tokens:,}")
    out.append(f"- **Schema version:** {SCHEMA_VERSION}")
    if not platform_breakdown.empty:
        out.append("- **Platform breakdown:**")
        for plat, count in platform_breakdown.items():
            out.append(f"  - `{plat}`: {count:,}")
    if "t_window_hours" in df.columns:
        windows = df["t_window_hours"].value_counts()
        out.append("- **Measurement windows (hours from launch):**")
        for w, count in windows.items():
            out.append(f"  - {w}h: {count:,}")
    out.append("")

    # Data quality runs FIRST so the reader sees degenerate inputs before the
    # findings that depend on them.
    out.extend(_data_quality_section(df, components_df, outcomes_df))

    # Component-by-outcome correlations
    out.append("## Component → outcome correlations")
    out.append("")
    out.append("Spearman rank correlation (rho) and AUC per (component, outcome label, horizon).")
    out.append("Higher |rho| + AUC > 0.55 indicates a component that meaningfully predicts outcome.")
    out.append("")
    if not correlations.empty:
        for label in OUTCOME_LABELS:
            sub = correlations[correlations["label"] == label]
            if sub.empty:
                continue
            out.append(f"### Outcome label: `{label}`")
            out.append("")
            out.append("| Component | 30d ρ | 30d AUC | 60d ρ | 60d AUC | 90d ρ | 90d AUC |")
            out.append("|---|---:|---:|---:|---:|---:|---:|")
            for comp in COMPONENTS_6:
                row = []
                for h in OUTCOME_HORIZONS:
                    cell = sub[(sub["component"] == comp) & (sub["horizon"] == h)]
                    if cell.empty:
                        row.extend(["—", "—"])
                    else:
                        rho = cell.iloc[0]["spearman_rho"]
                        auc = cell.iloc[0]["auc"]
                        row.append(f"{rho:+.3f}")
                        row.append(f"{auc:.3f}" if not math.isnan(auc) else "—")
                out.append(f"| `{comp}` | " + " | ".join(row) + " |")
            out.append("")
    else:
        out.append("_No correlation results — corpus had no varying outcome labels._")
        out.append("")

    # Feature importance
    out.append("## RandomForest feature importance")
    out.append("")
    out.append("Per outcome label, averaged across horizons. Higher values = component is more predictive in a non-linear model.")
    out.append("")
    if not importances.empty:
        pivot = importances.pivot(index="component", columns="label", values="importance")
        pivot = pivot.reindex(COMPONENTS_6)
        out.append("| Component | " + " | ".join(f"`{l}`" for l in OUTCOME_LABELS if l in pivot.columns) + " |")
        out.append("|---" + "|---:" * sum(1 for l in OUTCOME_LABELS if l in pivot.columns) + "|")
        for comp in COMPONENTS_6:
            row = [f"`{comp}`"]
            for label in OUTCOME_LABELS:
                if label not in pivot.columns:
                    continue
                v = pivot.at[comp, label] if comp in pivot.index else float("nan")
                row.append(f"{v:.3f}" if not math.isnan(v) else "—")
            out.append("| " + " | ".join(row) + " |")
        out.append("")
    else:
        out.append("_No feature-importance results._")
        out.append("")

    # Fitted weights
    out.append("## Fitted weights (L2 logistic regression)")
    out.append("")
    out.append("Weights derived empirically per outcome label, normalized to sum to 1.0.")
    out.append("Compare against the spec §6.5 default starting weights.")
    out.append("")
    out.append("| Component | Spec §6.5 default | " + " | ".join(f"Fitted ({l})" for l in OUTCOME_LABELS) + " |")
    out.append("|---|---:" + "|---:" * len(OUTCOME_LABELS) + "|")
    for comp in COMPONENTS_6:
        row = [f"`{comp}`", f"{CANDIDATE_WEIGHTS_6[comp]*100:.0f}%"]
        for label in OUTCOME_LABELS:
            w = fitted_weights_per_label.get(label, {})
            v = w.get(comp)
            row.append(f"{v*100:.1f}%" if v is not None else "—")
        out.append("| " + " | ".join(row) + " |")
    out.append("")

    # Cross-validated AUC per fitted model
    out.append("### Cross-validated AUC per fitted model (5-fold)")
    out.append("")
    out.append("How well the fitted weights actually predict the labeled outcome.")
    out.append("AUC > 0.65 is meaningful; AUC > 0.75 is strong.")
    out.append("")
    out.append("| Outcome label | CV AUC (mean ± std) |")
    out.append("|---|---:|")
    for label in OUTCOME_LABELS:
        w = fitted_weights_per_label.get(label, {})
        m = w.get("_cv_auc_mean")
        s = w.get("_cv_auc_std")
        if m is not None:
            out.append(f"| `{label}` | {m:.3f} ± {s:.3f} |")
        else:
            out.append(f"| `{label}` | — |")
    out.append("")

    # Rank stability
    out.append("## Rank stability — current weights vs candidate weights")
    out.append("")
    out.append("Spearman rank correlation between the HP rankings produced by two weight sets.")
    out.append("ρ ≥ 0.95 = nearly identical ranking. ρ < 0.80 = meaningfully different ranking.")
    out.append("")
    out.append("| Comparison | Rank ρ |")
    out.append("|---|---:|")
    for k, v in rank_stabilities.items():
        out.append(f"| {k} | {v:+.3f} |")
    out.append("")

    # Recommendation
    out.append("## Recommendation")
    out.append("")
    if is_synthetic:
        out.append("**This is synthetic data — DO NOT adopt the fitted weights as production values.**")
        out.append("The pipeline mechanics work; the outputs are demonstrably correct in shape.")
        out.append("Run again on a real corpus to derive real recommendations.")
    else:
        # Heuristic-based recommendation
        comp_avg_importance = (
            importances.groupby("component")["importance"].mean()
            if not importances.empty else pd.Series()
        )
        weak_components = comp_avg_importance[comp_avg_importance < 0.05].index.tolist() if not comp_avg_importance.empty else []
        out.append(f"- Components with low avg importance (< 0.05): {weak_components or 'none'}")
        if weak_components:
            out.append(f"- **Consider dropping or reducing weight on:** {', '.join(weak_components)}")
        out.append("- Compare cross-validated AUC across labels: prefer the label with highest AUC for weight-tuning")
        out.append("- If holderConcentration's importance is meaningful (> 0.10), confirm or raise spec §6.5 weight")
        out.append("- If holderConcentration's importance is low (< 0.05), spec §41.7 says drop the component")
    out.append("")

    out.append("## Methodology")
    out.append("")
    out.append("- HP components computed per spec §6.4 + §41.4 implementations")
    out.append("- Velocity / effectiveBuyers / stickyLiquidity normalized via corpus-relative percentile rank (so composite makes sense across the corpus). Other 3 components already 0-1 by construction.")
    out.append("- Component → outcome correlations: Spearman ρ (rank-based, robust to outliers) + ROC AUC")
    out.append("- Feature importance: RandomForest with 200 trees, default depth, averaged across horizons")
    out.append("- Weight fitting: L2-regularized logistic regression on standardized components, coefficients clipped to non-negative, normalized to sum to 1.0")
    out.append("- Rank stability: Spearman ρ between HP rankings under two different weight sets")
    out.append("- Cross-validation: 5-fold stratified, mean ± std AUC")
    out.append("")

    out.append("---")
    out.append("")
    out.append("_End of report. Pipeline source: `pipeline.py`. Data schema: `data_schema.md`._")
    return "\n".join(out)


# ============================================================================
# Synthetic data generation
# ============================================================================

def generate_synthetic_corpus(n_tokens: int = 500, seed: int = 42) -> pd.DataFrame:
    """
    Generate a plausible synthetic corpus that mimics realistic launchpad data.

    Realistic distributions:
    - Most tokens fail (long-tail decay in features + outcomes)
    - ~20% have decent retention
    - ~5% become "good" (composite outcome True at 30d+)
    - HHI distributed log-normal (most concentrated, tail well-distributed)
    - Outcome labels correlated with HP components in believable ways
    """
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(n_tokens):
        # "True quality" latent — most tokens are bad, a few are good (Pareto)
        quality = rng.beta(0.5, 3.0)  # peaked near 0, long tail to 1

        # Velocity inputs: log-normal with quality bias
        total_volume = float(rng.lognormal(mean=0.5 + 2 * quality, sigma=1.2))
        decayed_volume = total_volume * (0.4 + 0.5 * rng.random())

        # Effective buyers: number of buyers + per-wallet vol distribution
        n_buyers = max(1, int(rng.lognormal(mean=2 + 2.5 * quality, sigma=0.8)))
        # Per-wallet volumes — Pareto distribution
        if n_buyers > 0:
            buyer_vols = list(np.round(
                np.random.default_rng(seed + i).pareto(2.0, n_buyers) * total_volume / max(n_buyers, 1) + 0.01,
                4,
            ).tolist())
        else:
            buyer_vols = []

        # Sticky liquidity: depth * quality, removal sometimes
        lp_depth = float(rng.lognormal(mean=0.5 + 1.5 * quality, sigma=1.0))
        lp_removed = float(rng.choice([0, 0, 0, rng.uniform(0, lp_depth * 0.3)]))

        # Retention: directly correlated with quality + noise
        early = max(5, int(rng.lognormal(mean=2 + 2 * quality, sigma=0.6)))
        retention_rate = min(1.0, max(0.0, quality + rng.normal(0, 0.15)))
        still_holding = int(early * retention_rate)

        # Momentum: small recent change, often near zero
        hp_delta = float(rng.normal(0.02 * quality, 0.04))

        # Holder distribution: HHI log-normal — most concentrated
        # Higher quality → more distributed
        n_holders = max(2, int(rng.lognormal(mean=2.5 + 2.5 * quality, sigma=0.7)))
        # Generate holder balances: Pareto-distributed shares
        # Bad tokens have severe concentration, good ones less so
        pareto_alpha = 1.0 + 1.5 * quality  # higher alpha = less concentrated
        balances = np.random.default_rng(seed * 2 + i).pareto(pareto_alpha, n_holders) * 1000 + 10
        # Sort descending to ensure top-1 has the most
        balances = list(np.round(np.sort(balances)[::-1], 2).tolist())

        # Outcome labels — correlated with quality, more noise at longer horizons
        def gen_outcome(horizon_factor: float, threshold: float = 0.5) -> dict:
            noise = rng.normal(0, 0.12 * horizon_factor)
            score = quality + noise
            return {
                "holder_retention": int(score > threshold * 0.5),
                "price_floor": int(score > threshold * 0.6),
                "volume_slope": int(score > threshold * 0.7),
                "composite": int(score > threshold * 0.8),
            }

        out_30 = gen_outcome(1.0)
        out_60 = gen_outcome(1.4)
        out_90 = gen_outcome(1.8)

        rows.append({
            "token_address": f"0x{i:040x}",
            "ticker": f"SYN{i:04d}",
            "chain": "base",
            "platform": rng.choice(["clanker", "bankr", "liquid", "filterfun"], p=[0.5, 0.25, 0.15, 0.10]),
            "launch_ts": int(1714521600 - i * 3600),  # synthetic timeline
            "t_window_hours": 96,
            "total_buy_volume_eth": round(total_volume, 4),
            "total_buy_volume_eth_decayed": round(decayed_volume, 4),
            "unique_buyers": n_buyers,
            "buyer_volumes_eth_json": json.dumps(buyer_vols[:200]),  # cap for CSV size
            "lp_depth_eth": round(lp_depth, 4),
            "lp_removed_24h_eth": round(lp_removed, 4),
            "early_holders_count": early,
            "early_holders_still_holding": still_holding,
            "hp_delta_recent": round(hp_delta, 5),
            "holder_count": n_holders,
            "holder_balances_json": json.dumps(balances[:200]),  # cap
            "outcome_30d_holder_retention": out_30["holder_retention"],
            "outcome_30d_price_floor": out_30["price_floor"],
            "outcome_30d_volume_slope": out_30["volume_slope"],
            "outcome_30d_composite": out_30["composite"],
            "outcome_60d_holder_retention": out_60["holder_retention"],
            "outcome_60d_price_floor": out_60["price_floor"],
            "outcome_60d_volume_slope": out_60["volume_slope"],
            "outcome_60d_composite": out_60["composite"],
            "outcome_90d_holder_retention": out_90["holder_retention"],
            "outcome_90d_price_floor": out_90["price_floor"],
            "outcome_90d_volume_slope": out_90["volume_slope"],
            "outcome_90d_composite": out_90["composite"],
            "name": f"Synthetic Token {i}",
            "creator_address": f"0x{(seed + i):040x}",
            "notes": f"quality={quality:.3f}",
        })
    return pd.DataFrame(rows)


# ============================================================================
# Main
# ============================================================================

def _recompute_survived_to_day_7(df: pd.DataFrame, *,
                                  holders_min: int,
                                  lp_min_eth: float,
                                  vol_min_eth: float) -> int:
    """Track-E v4: recompute the survived_to_day_7 column from the raw 168h
    gate components. Delegates the actual gate semantics to survival_gate
    (single source of truth — bugbot #66 finding 13). No-op for pre-v4
    corpora that lack the raw gate fields."""
    from survival_gate import survival_mask
    mask = survival_mask(df, holders_min=holders_min,
                          lp_min_eth=lp_min_eth, vol_min_eth=vol_min_eth)
    if mask is None:
        return 0  # silent no-op; data-quality section flags missing columns
    df["survived_to_day_7"] = mask
    return int(mask.sum())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=None, help="Path to corpus CSV (defaults to synthetic)")
    parser.add_argument("--output", default=None, help="Path to output report markdown")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--n-synthetic", type=int, default=500)
    # v4: post-hoc survival-gate calibration. Defaults match the fetcher's
    # at-fetch-time gates so behavior matches v3 unless overridden.
    parser.add_argument("--survived-holders-min", type=int, default=5,
                        help="Minimum holders at t+168h for survived_to_day_7=1")
    parser.add_argument("--survived-lp-min-eth", type=float, default=0.5,
                        help="Minimum LP depth (ETH) at t+168h for survival")
    parser.add_argument("--survived-vol-min-eth", type=float, default=0.0,
                        help="Strictly-greater-than threshold for trailing-24h "
                             "swap volume (ETH) at t+168h for survival")
    args = parser.parse_args()

    here = Path(__file__).parent
    is_synthetic = args.input is None

    if is_synthetic:
        synth_path = here / "synthetic_corpus.csv"
        print(f"Generating {args.n_synthetic} synthetic tokens (seed={args.seed})...")
        df = generate_synthetic_corpus(n_tokens=args.n_synthetic, seed=args.seed)
        df.to_csv(synth_path, index=False)
        print(f"  Wrote {synth_path}")
    else:
        print(f"Loading corpus from {args.input}...")
        df = pd.read_csv(args.input)
        n_survived = _recompute_survived_to_day_7(
            df,
            holders_min=args.survived_holders_min,
            lp_min_eth=args.survived_lp_min_eth,
            vol_min_eth=args.survived_vol_min_eth,
        )
        if "holders_at_168h" in df.columns:
            print(f"  recomputed survived_to_day_7 with gate "
                  f"(holders≥{args.survived_holders_min}, "
                  f"lp≥{args.survived_lp_min_eth} ETH, "
                  f"vol>{args.survived_vol_min_eth} ETH) → "
                  f"{n_survived}/{len(df)} ({n_survived/max(len(df),1)*100:.0f}%)")

    print(f"Computing HP components for {len(df):,} tokens...")
    components_df = compute_components(df)

    print("Correlating components with outcomes...")
    correlations = correlate_components_to_outcomes(components_df, df)

    print("Computing RandomForest feature importance...")
    importances = feature_importance_per_label(components_df, df, seed=args.seed)

    print("Fitting weights via L2 logistic regression...")
    fitted_weights_per_label = {}
    for label in OUTCOME_LABELS:
        # Use 30d horizon for fitting (most data, least noise)
        w = fit_weights_logreg(components_df, df, target_label=label, target_horizon="30d", seed=args.seed)
        fitted_weights_per_label[label] = w

    print("Computing rank stability...")
    rank_stabilities = {
        "Current 5-component (35/20/20/15/10) vs Candidate 6-component (30/15/20/15/10/10)":
            rank_stability(components_df, CURRENT_WEIGHTS_5, CANDIDATE_WEIGHTS_6),
    }
    # Stability of fitted vs candidate
    for label in OUTCOME_LABELS:
        w = {k: v for k, v in fitted_weights_per_label.get(label, {}).items() if not k.startswith("_")}
        if w:
            rho = rank_stability(components_df, CANDIDATE_WEIGHTS_6, w)
            rank_stabilities[f"Candidate vs Fitted ({label})"] = rho

    print("Generating report...")
    report = render_report(
        df, components_df, df,  # outcomes_df is part of df
        correlations, importances, fitted_weights_per_label, rank_stabilities,
        is_synthetic=is_synthetic, seed=args.seed,
    )

    output_path = args.output or (here / ("SYNTHETIC_DEMO_REPORT.md" if is_synthetic else "REPORT.md"))
    Path(output_path).write_text(report)
    print(f"Wrote {output_path}")


if __name__ == "__main__":
    main()
