"""Track-E v4: validation cohort — Spearman ρ between HP rank and FDV rank.

Reads validation_corpus.csv produced by validation_cohort.py, scores each
token with the SAME per-component scorers pipeline.py uses (imported
directly to avoid drift — bugbot #76 finding 1 caught a divergent local
re-implementation that computed holderConcentration as
`tanh(holder_count/100)` instead of the spec's HHI on holder_balances_json,
silently corrupting the rank order).

Component scoring follows pipeline.py::compute_components:
  - velocity / effectiveBuyers / stickyLiquidity → percentile-rank within
    the cohort (already on a 0–1 scale)
  - retention / momentum / holderConcentration → already 0–1 by construction

The composite is the weighted sum × 100 (matching the spec's HP scale).

The FDV is stashed in `notes` as `validation_cohort:fdv_eth=X.XXXXXX`
because TokenExtraction has no fdv_eth slot.

Two weight sets are scored:
  - §6.5 LOCKED (Scenario B): drop momentum, redistribute its 10% to
    stickyLiquidity → 30/15/30/15/0/10
  - Pre-v4 spec defaults: 30/15/20/15/10/10

Run:
    uv run python3 validate_hp_rank.py --input validation_corpus.csv

Output is a markdown block ready to paste into REPORT_v4_validation.md.
"""

from __future__ import annotations

import argparse
import re
import sys

import pandas as pd
from scipy.stats import spearmanr

from pipeline import (
    effective_buyers_score,
    hhi_score,
    momentum_score,
    retention_score,
    sticky_liquidity_score,
    velocity_score,
)

WEIGHTS_V4_LOCKED = {
    "velocity": 0.30,
    "effectiveBuyers": 0.15,
    "stickyLiquidity": 0.30,
    "retention": 0.15,
    "momentum": 0.0,
    "holderConcentration": 0.10,
}

WEIGHTS_SPEC_DEFAULTS = {
    "velocity": 0.30,
    "effectiveBuyers": 0.15,
    "stickyLiquidity": 0.20,
    "retention": 0.15,
    "momentum": 0.10,
    "holderConcentration": 0.10,
}

# Components that pipeline.py percentile-ranks before weighting (the raw
# values are unbounded; the rank-then-weight is what makes the composite
# meaningful across a corpus).
PERCENTILE_RANKED = ("velocity", "effectiveBuyers", "stickyLiquidity")

FDV_RE = re.compile(r"validation_cohort:fdv_eth=([0-9.]+)")


def _components_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """Mirror pipeline.compute_components on this cohort: raw scores, then
    percentile-rank the unbounded ones (the pipeline normalizes to 0–1 via
    rank within the corpus, not via tanh — see pipeline.compute_components).
    """
    raw = pd.DataFrame({
        "velocity_raw": df.apply(velocity_score, axis=1),
        "effectiveBuyers_raw": df.apply(effective_buyers_score, axis=1),
        "stickyLiquidity_raw": df.apply(sticky_liquidity_score, axis=1),
        "retention": df.apply(retention_score, axis=1),
        "momentum": df.apply(momentum_score, axis=1),
        "holderConcentration": df.apply(hhi_score, axis=1),
    })
    out = raw.copy()
    for comp in PERCENTILE_RANKED:
        # rank(method='average', pct=True) → values in (0, 1].
        out[comp] = raw[f"{comp}_raw"].rank(method="average", pct=True)
    return out[
        ["velocity", "effectiveBuyers", "stickyLiquidity",
         "retention", "momentum", "holderConcentration"]
    ]


def _weighted(comps: pd.DataFrame, weights: dict[str, float]) -> pd.Series:
    return sum(weights[k] * comps[k] for k in weights) * 100.0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", default="validation_corpus.csv")
    args = p.parse_args(argv)

    df = pd.read_csv(args.input)
    if "notes" not in df.columns:
        sys.exit("notes column missing — wrong CSV format")

    fdvs: list[float] = []
    for _, row in df.iterrows():
        m = FDV_RE.search(str(row.get("notes", "")))
        fdvs.append(float(m.group(1)) if m else float("nan"))
    df["fdv_eth"] = fdvs
    df = df.dropna(subset=["fdv_eth"]).reset_index(drop=True)

    n = len(df)
    if n < 3:
        print(f"⚠ n={n} too small for rank correlation — bailing.", file=sys.stderr)
        return 1

    comps = _components_dataframe(df)
    df["hp_locked"] = _weighted(comps, WEIGHTS_V4_LOCKED)
    df["hp_spec"] = _weighted(comps, WEIGHTS_SPEC_DEFAULTS)

    rho_locked, p_locked = spearmanr(df["hp_locked"], df["fdv_eth"])
    rho_spec, p_spec = spearmanr(df["hp_spec"], df["fdv_eth"])

    df_sorted = df.sort_values("fdv_eth", ascending=False)

    out = [
        "### Validation cohort — HP rank vs FDV rank (Spearman ρ)",
        "",
        f"Cohort: **n={n}** tokens (top by current FDV from a 5,000-token "
        "random subsample of Clanker V4 candidates + all 120 Liquid V1 "
        "candidates over the [180d, 30d] discovery window — see "
        "REPORT_v4_validation.md for the methodology note).",
        "",
        "Scoring path: `pipeline.compute_components` (raw scores from "
        "pipeline.py imported directly; the three unbounded components — "
        "velocity, effectiveBuyers, stickyLiquidity — are percentile-ranked "
        "within the cohort, then weighted and summed × 100).",
        "",
        "| Weight set | Spearman ρ | p-value |",
        "|---|---:|---:|",
        f"| §6.5 LOCKED (Scenario B: 30/15/30/15/0/10) | {rho_locked:+.3f} | {p_locked:.3f} |",
        f"| Pre-v4 spec defaults (30/15/20/15/10/10) | {rho_spec:+.3f} | {p_spec:.3f} |",
        "",
        "Per-token scores (sorted by FDV desc):",
        "",
        "| token | platform | fdv_eth | hp_locked | hp_spec |",
        "|---|---|---:|---:|---:|",
    ]
    for _, r in df_sorted.iterrows():
        name = (r.get("name") or r.get("ticker") or r["token_address"][:10])[:24]
        out.append(
            f"| `{r['token_address'][:10]}…` ({name}) | "
            f"{r.get('platform', '')} | {r['fdv_eth']:.3f} | "
            f"{r['hp_locked']:.2f} | {r['hp_spec']:.2f} |"
        )

    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
