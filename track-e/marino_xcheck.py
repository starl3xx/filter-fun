"""Track-E v4: Marino et al pump.fun cross-check on the v4 corpus.

Marino et al's strongest single predictor of pump.fun token survival was
"fast accumulation of liquidity through small number of trades" — i.e.,
high velocity (cumulative buy volume) concentrated in a low effective
buyer count. The pattern suggests whales / front-runners rather than
genuine retail demand; tokens in this regime are predicted to be more
likely to dump.

This script tests the same pattern against our Clanker V4 corpus by
computing the survival-rate differential between:
    A) ALL survivor-half tokens (≥1 buyer, ≥0.001 ETH buy volume)
    B) the "Marino sniped" subset within (A): velocity ≥ 75th percentile
       AND effective_buyers ≤ 25th percentile

If Marino generalizes to Base+V4, (B) should have a notably LOWER
survived_to_day_7 rate than (A). Marino's effect size on pump.fun was
~30% points lower survival in the sniped subset; we report the actual
differential and call out whether it agrees, disagrees, or is too noisy
to tell from our (smaller) corpus.

Run after pipeline.py has applied the calibrated survival gate:
    uv run python3 pipeline.py --input v4_corpus.csv --output REPORT.md \\
        --survived-holders-min N --survived-lp-min-eth X
    uv run python3 marino_xcheck.py --input v4_corpus.csv

Output: a markdown block ready to paste into REPORT_v4.md §5.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import pandas as pd


def _effective_buyers_from_row(row: pd.Series) -> float:
    """Mirror pipeline.py::effective_buyers_score so this script doesn't
    drift out of sync with the canonical implementation. Returns
    sum(sqrt(per-wallet-volume)) when the JSON is available, else falls
    back to the same heuristic pipeline.py uses."""
    js = row.get("buyer_volumes_eth_json", "")
    if isinstance(js, str) and js.strip():
        try:
            volumes = json.loads(js)
            return float(sum(math.sqrt(max(0.0, v)) for v in volumes))
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
    n = int(row.get("unique_buyers", 0) or 0)
    total = float(row.get("total_buy_volume_eth", 0.0) or 0.0)
    if n <= 0 or total <= 0:
        return 0.0
    return n * math.sqrt(total / n)


def _recompute_survival(df: pd.DataFrame, *, holders_min: int,
                        lp_min_eth: float, vol_min_eth: float) -> pd.Series:
    """Return a recomputed survived_to_day_7 series from raw 168h fields.
    Mirrors pipeline.py::_recompute_survived_to_day_7 — kept local so the
    Marino check runs against whatever gate the analyst chooses."""
    needed = ["holders_at_168h", "lp_depth_168h_eth", "vol_24h_at_168h_eth"]
    if not all(c in df.columns for c in needed):
        return df.get("survived_to_day_7", pd.Series([0] * len(df))).astype(int)
    h = pd.to_numeric(df["holders_at_168h"], errors="coerce").fillna(0)
    l = pd.to_numeric(df["lp_depth_168h_eth"], errors="coerce").fillna(0.0)
    v = pd.to_numeric(df["vol_24h_at_168h_eth"], errors="coerce").fillna(0.0)
    return ((h >= holders_min) & (l >= lp_min_eth) & (v > vol_min_eth)).astype(int)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True, help="Path to v4_corpus.csv")
    p.add_argument("--velocity-percentile", type=float, default=0.75,
                   help="Velocity ≥ this percentile defines the high-velocity half")
    p.add_argument("--effbuyers-percentile", type=float, default=0.25,
                   help="effectiveBuyers ≤ this percentile defines the "
                        "low-effective-buyer half")
    p.add_argument("--survived-holders-min", type=int, default=5)
    p.add_argument("--survived-lp-min-eth", type=float, default=0.5)
    p.add_argument("--survived-vol-min-eth", type=float, default=0.0)
    args = p.parse_args(argv)

    df = pd.read_csv(args.input)

    # Survivor-half = same gate as the fetcher's stratified bucketing.
    surv_mask = (df["unique_buyers"] >= 1) & (df["total_buy_volume_eth"] >= 0.001)
    sh = df[surv_mask].copy()
    n_sh = len(sh)
    if n_sh < 5:
        print(f"survivor-half too small (n={n_sh}) — Marino check is meaningless. "
              "Wait for a larger stratified corpus.", file=sys.stderr)
        return 1

    sh["survived"] = _recompute_survival(
        sh,
        holders_min=args.survived_holders_min,
        lp_min_eth=args.survived_lp_min_eth,
        vol_min_eth=args.survived_vol_min_eth,
    )
    sh["velocity_raw"] = pd.to_numeric(
        sh["total_buy_volume_eth_decayed"].fillna(sh["total_buy_volume_eth"]),
        errors="coerce",
    ).fillna(0.0)
    sh["effbuyers_raw"] = sh.apply(_effective_buyers_from_row, axis=1)

    v_thresh = sh["velocity_raw"].quantile(args.velocity_percentile)
    e_thresh = sh["effbuyers_raw"].quantile(args.effbuyers_percentile)
    sniped_mask = (sh["velocity_raw"] >= v_thresh) & (sh["effbuyers_raw"] <= e_thresh)
    n_sniped = int(sniped_mask.sum())

    rate_all = float(sh["survived"].mean())
    rate_sniped = float(sh.loc[sniped_mask, "survived"].mean()) if n_sniped > 0 else 0.0
    diff = rate_sniped - rate_all

    # Markdown block, paste into REPORT_v4 §5
    lines = [
        "### Marino et al — pump.fun cross-check",
        "",
        "Marino's strongest predictor of token failure is high velocity "
        "concentrated in a small number of effective buyers (whale/sniper "
        "pattern). Test on Base+V4 by partitioning the survivor-half on "
        f"the same axes (velocity ≥ p{int(args.velocity_percentile*100)}, "
        f"effectiveBuyers ≤ p{int(args.effbuyers_percentile*100)}).",
        "",
        "| Subset | n | survived_to_day_7 rate |",
        "|---|---:|---:|",
        f"| All survivor-half | {n_sh} | {rate_all:.0%} |",
        f"| Sniped subset (Marino) | {n_sniped} | "
        f"{rate_sniped:.0%}{' — *too small to interpret*' if n_sniped < 5 else ''} |",
        f"| Differential (sniped − all) | — | {diff:+.0%} |",
        "",
    ]
    if n_sniped < 5:
        lines += [
            "→ **Indeterminate.** The sniped subset is too small to draw a "
            "reliable conclusion. Marino's effect requires ~50+ tokens in "
            "the subset to be statistically detectable.",
            "",
        ]
    elif diff <= -0.10:
        lines += [
            f"→ **Agrees with Marino.** Sniped tokens survive at "
            f"{abs(diff):.0%}-points lower than the average — same direction "
            "as Marino's pump.fun finding.",
            "",
        ]
    elif diff >= 0.10:
        lines += [
            f"→ **Disagrees with Marino.** Sniped tokens survive at "
            f"{diff:.0%}-points HIGHER than the average — opposite of Marino. "
            "Possible mechanism: V4 lockers + dynamic-fee hooks may neutralize "
            "the sniper-dump pattern that pump.fun's bonding curve allowed.",
            "",
        ]
    else:
        lines += [
            f"→ **Inconclusive.** Differential is small ({diff:+.0%}); not "
            "enough signal to confirm or contradict Marino. Likely needs a "
            "larger corpus or a different cut-point.",
            "",
        ]

    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
