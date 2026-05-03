"""Track-E v4 Prereq 4: post-hoc calibration of survived_to_day_7 thresholds.

Reads the raw 168h gate components from corpus.csv (`holders_at_168h`,
`lp_depth_168h_eth`, `vol_24h_at_168h_eth`) and sweeps several threshold
combinations to find one that puts the true-rate inside [30%, 70%] on the
survivor half (the bucket of tokens with ≥1 buyer + ≥0.001 ETH buy volume).

The fetcher writes survived_to_day_7 with the at-fetch-time defaults
(SURVIVED_HOLDERS_MIN=5, SURVIVED_LP_MIN_ETH=0.5, SURVIVED_VOL_MIN_ETH=0.0).
This script does NOT mutate the CSV — it prints a table and a recommended
gate set. Apply it by setting the constants in fetch_corpus.py (the
recompute is then implicit on the next reload that reads the raw fields).

Run:
    uv run python3 calibrate_survival.py --input corpus.csv

Or to produce only the recommendation:
    uv run python3 calibrate_survival.py --input corpus.csv --quiet
"""

from __future__ import annotations

import argparse
import sys
from itertools import product
from pathlib import Path

import pandas as pd

from survival_gate import survival_mask


# Gate combos to sweep — chosen to cover the dispatch's "loosen until [30%,
# 70%] band is hit" iteration. Listed coarse → tight so the first match in
# the [30%, 70%] band is the most permissive (lowest false-survivor risk).
HOLDER_THRESHOLDS = [1, 2, 3, 5, 10]
LP_THRESHOLDS_ETH = [0.0, 0.05, 0.1, 0.25, 0.5, 1.0]
VOL_THRESHOLDS_ETH = [0.0, 0.001, 0.01]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True, help="Path to corpus.csv")
    p.add_argument("--quiet", action="store_true",
                   help="Print only the recommended threshold combo")
    p.add_argument("--target-low", type=float, default=0.30)
    p.add_argument("--target-high", type=float, default=0.70)
    args = p.parse_args(argv)

    df = pd.read_csv(args.input)
    needed = ["holders_at_168h", "lp_depth_168h_eth", "vol_24h_at_168h_eth",
              "unique_buyers", "total_buy_volume_eth"]
    missing = [c for c in needed if c not in df.columns]
    if missing:
        print(f"error: missing columns in {args.input}: {missing}", file=sys.stderr)
        print("  This corpus was likely fetched with cache_schema < 6 — re-run "
              "fetch_corpus.py with the v4 fetcher to populate the raw 168h "
              "gate components.", file=sys.stderr)
        return 1

    # Survivor-half = same gate as the fetcher's stratified bucketing.
    surv_mask = (df["unique_buyers"] >= 1) & (df["total_buy_volume_eth"] >= 0.001)
    survivor_half = df[surv_mask]
    n_total = len(df)
    n_surv = len(survivor_half)
    if n_surv == 0:
        print(f"error: 0 of {n_total} corpus tokens are in the survivor "
              "half — calibration is moot. Check the corpus is from a "
              "stratified v4 fetch with --pilot 250 --stratified.", file=sys.stderr)
        return 1

    if not args.quiet:
        print(f"Calibrating survived_to_day_7 against {n_surv} survivor-half "
              f"tokens ({n_total} total).")
        print(f"Target band: [{args.target_low:.0%}, {args.target_high:.0%}]\n")
        print(f"{'holders':>8} {'lp_eth':>7} {'vol_eth':>8} | "
              f"{'rate':>6} {'count':>6} {'in_band?':>9}")
        print("-" * 56)

    rows = []
    for h, l, v in product(HOLDER_THRESHOLDS, LP_THRESHOLDS_ETH, VOL_THRESHOLDS_ETH):
        # Delegate to the shared gate (bugbot #66 finding 13) so the sweep
        # stays in sync with pipeline.py / marino_xcheck.py / fetch_corpus.py.
        m = survival_mask(survivor_half, holders_min=h,
                          lp_min_eth=l, vol_min_eth=v)
        rate = float(m.mean())
        in_band = args.target_low <= rate <= args.target_high
        rows.append((h, l, v, rate, int(m.sum()), in_band))
        if not args.quiet:
            tag = "✓" if in_band else " "
            print(f"{h:>8} {l:>7.3f} {v:>8.3f} | "
                  f"{rate:>5.0%} {int(m.sum()):>6} {tag:>9}")

    in_band_rows = [r for r in rows if r[5]]
    if not in_band_rows:
        print(f"\n⚠ No combo in this sweep landed inside "
              f"[{args.target_low:.0%}, {args.target_high:.0%}] band.", file=sys.stderr)
        # Fall back to whichever combo was closest to the band's midpoint.
        midpoint = (args.target_low + args.target_high) / 2
        rows.sort(key=lambda r: abs(r[3] - midpoint))
        h, l, v, rate, count, _ = rows[0]
        print(f"\nClosest-to-midpoint combo: holders≥{h}, lp_eth≥{l}, "
              f"vol_eth>{v}  → rate={rate:.0%} ({count}/{n_surv})")
        return 2

    # Pick the most permissive combo in band (the dispatch's intent: don't
    # over-tune to get into band — the loosest gate that produces a usable
    # signal is the principled choice).
    in_band_rows.sort(key=lambda r: (r[0], r[1], r[2]))
    h, l, v, rate, count, _ = in_band_rows[0]
    print(f"\n✓ Recommended gate (loosest in band):\n"
          f"  SURVIVED_HOLDERS_MIN = {h}\n"
          f"  SURVIVED_LP_MIN_ETH  = {l}\n"
          f"  SURVIVED_VOL_MIN_ETH = {v}\n"
          f"  → rate = {rate:.0%} ({count}/{n_surv} survivor-half tokens)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
