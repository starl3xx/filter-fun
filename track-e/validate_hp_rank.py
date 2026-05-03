"""Track-E v4: validation cohort — Spearman ρ between HP rank and FDV rank.

Reads validation_corpus.csv produced by validation_cohort.py and calls
`pipeline.compute_components` + `pipeline.composite_hp` directly so the
HP scoring stays bit-for-bit identical to production. Bugbot #76 caught
two flavors of drift in earlier iterations of this file:
  - finding 1 (HIGH): local _hp_components computed holderConcentration
    as tanh(holder_count/100) instead of HHI on balances.
  - finding 3 (Low): even after importing the raw scorers, the local
    percentile-rank + weighted-sum logic was a separate divergence
    surface. Now the entire scoring path delegates to pipeline.

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

from pipeline import composite_hp, compute_components

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

FDV_RE = re.compile(r"validation_cohort:fdv_eth=([0-9.]+)")


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

    comps = compute_components(df)
    df["hp_locked"] = composite_hp(comps, WEIGHTS_V4_LOCKED)
    df["hp_spec"] = composite_hp(comps, WEIGHTS_SPEC_DEFAULTS)

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
        "Scoring path: `pipeline.compute_components` + `pipeline.composite_hp` "
        "called directly (no local re-derivation — bit-for-bit identical to "
        "the production scoring).",
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
    def _label(r: pd.Series) -> str:
        # pandas missing values are NaN (truthy), not None (falsy), so an
        # `or`-chain fallback short-circuits on NaN and then raises on
        # `NaN[:24]` (bugbot #76 finding 4). Walk explicitly with isna.
        for col in ("name", "ticker"):
            v = r.get(col)
            if isinstance(v, str) and v:
                return v[:24]
        return r["token_address"][:10]

    for _, r in df_sorted.iterrows():
        name = _label(r)
        out.append(
            f"| `{r['token_address'][:10]}…` ({name}) | "
            f"{r.get('platform', '')} | {r['fdv_eth']:.3f} | "
            f"{r['hp_locked']:.2f} | {r['hp_spec']:.2f} |"
        )

    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
