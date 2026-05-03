"""Track-E v4: validation cohort — Spearman ρ between HP rank and FDV rank.

Reads validation_corpus.csv produced by validation_cohort.py, scores each
token under the proposed §6.5 weights from REPORT_v4.md (Scenario B —
drop momentum, redistribute its 10% to stickyLiquidity → 30/15/30/15/0/10),
and reports the rank correlation against FDV (the validation target).

The FDV is stashed in `notes` as `validation_cohort:fdv_eth=X.XXXXXX`
because TokenExtraction has no fdv_eth slot.

Run:
    uv run python3 validate_hp_rank.py --input validation_corpus.csv

Output is a markdown block ready to paste into REPORT_v4_validation.md.
"""

from __future__ import annotations

import argparse
import math
import re
import sys

import pandas as pd
from scipy.stats import spearmanr

# Proposed §6.5 weights (Scenario B — drop momentum, redistribute to sticky)
WEIGHTS_V4_LOCKED = {
    "velocity": 0.30,
    "effectiveBuyers": 0.15,
    "stickyLiquidity": 0.30,
    "retention": 0.15,
    "momentum": 0.0,
    "holderConcentration": 0.10,
}

# Spec defaults (pre-v4) for comparison
WEIGHTS_SPEC_DEFAULTS = {
    "velocity": 0.30,
    "effectiveBuyers": 0.15,
    "stickyLiquidity": 0.20,
    "retention": 0.15,
    "momentum": 0.10,
    "holderConcentration": 0.10,
}

FDV_RE = re.compile(r"validation_cohort:fdv_eth=([0-9.]+)")


def _hp_components(row: pd.Series) -> dict[str, float]:
    """Mirror pipeline.py's per-component scorers in their normalized form
    (each ∈ [0, 1]). Kept inline so this script doesn't import pipeline
    (which has heavy sklearn deps and a CLI side effect)."""
    velocity = math.tanh(float(row.get("total_buy_volume_eth_decayed",
                                         row.get("total_buy_volume_eth", 0)) or 0) / 5.0)
    nbuy = int(row.get("unique_buyers", 0) or 0)
    total = float(row.get("total_buy_volume_eth", 0) or 0)
    eff = (nbuy * math.sqrt(total / nbuy)) if (nbuy > 0 and total > 0) else 0.0
    effective_buyers = math.tanh(eff / 10.0)
    lp_depth = float(row.get("lp_depth_eth", 0) or 0)
    sticky = math.tanh(lp_depth / 5.0)
    holders_keep = float(row.get("early_holders_still_holding", 0) or 0)
    holders_total = float(row.get("early_holders_count", 0) or 0)
    retention = (holders_keep / holders_total) if holders_total > 0 else 0.0
    momentum = max(0.0, math.tanh(float(row.get("hp_delta_recent", 0) or 0)))
    holders = int(row.get("holder_count", 0) or 0)
    holder_conc = math.tanh(holders / 100.0)
    return {
        "velocity": velocity,
        "effectiveBuyers": effective_buyers,
        "stickyLiquidity": sticky,
        "retention": retention,
        "momentum": momentum,
        "holderConcentration": holder_conc,
    }


def _hp_score(comps: dict[str, float], weights: dict[str, float]) -> float:
    return sum(weights[k] * comps[k] for k in weights)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", default="validation_corpus.csv")
    args = p.parse_args(argv)

    df = pd.read_csv(args.input)
    if "notes" not in df.columns:
        sys.exit("notes column missing — wrong CSV format")

    # Pull FDV out of the notes column.
    fdvs: list[float] = []
    for _, row in df.iterrows():
        m = FDV_RE.search(str(row.get("notes", "")))
        fdvs.append(float(m.group(1)) if m else float("nan"))
    df["fdv_eth"] = fdvs
    df = df.dropna(subset=["fdv_eth"]).copy()

    # Score under both weight sets so we can show whether the v4 lock helps.
    df["hp_locked"] = df.apply(
        lambda r: _hp_score(_hp_components(r), WEIGHTS_V4_LOCKED), axis=1)
    df["hp_spec"] = df.apply(
        lambda r: _hp_score(_hp_components(r), WEIGHTS_SPEC_DEFAULTS), axis=1)

    n = len(df)
    if n < 3:
        print(f"⚠ n={n} too small for rank correlation — bailing.", file=sys.stderr)
        return 1

    rho_locked, p_locked = spearmanr(df["hp_locked"], df["fdv_eth"])
    rho_spec, p_spec = spearmanr(df["hp_spec"], df["fdv_eth"])

    # Per-token table sorted by FDV desc.
    df_sorted = df.sort_values("fdv_eth", ascending=False)

    out = [
        "### Validation cohort — HP rank vs FDV rank (Spearman ρ)",
        "",
        f"Cohort: **n={n}** tokens (top by current FDV from a 5,000-token "
        "random subsample of Clanker V4 candidates + all 120 Liquid V1 "
        "candidates over the [180d, 30d] discovery window — see "
        "REPORT_v4_validation.md for the methodology note).",
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
            f"{r['hp_locked']:.3f} | {r['hp_spec']:.3f} |"
        )

    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
