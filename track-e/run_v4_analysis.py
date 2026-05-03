"""Track-E v4: post-fetch analysis orchestrator.

Once `fetch_corpus.py --pilot N --stratified --snapshot-log <path>
--output v4_corpus.csv` has finished, this script runs the four analysis
passes in order and prints their outputs in the structure that
REPORT_v4_TEMPLATE.md expects:

    1. calibrate_survival.py — pick the gate inside [30%, 70%] band.
    2. pipeline.py            — run HP correlations + L2 fit + RF importance
                                with the calibrated gate (writes REPORT.md).
    3. diagnostic_hp_delta.py — bucket the snapshot log into varying /
                                flat / all_zero / partial.
    4. marino_xcheck.py       — pump.fun whale-sniper cross-check.

Then prints a "fill the template" cheat sheet showing which output goes
into which REPORT_v4_TEMPLATE.md section, and what the operator's
remaining decisions are (Scenario A vs B + the literal §6.5 spec diff).

Run:
    uv run python3 run_v4_analysis.py \\
        --corpus v4_corpus.csv \\
        --snapshot-log /tmp/v4_snapshots.jsonl

Output goes to stdout; pipe to a file if you want a record:
    uv run python3 run_v4_analysis.py ... | tee /tmp/v4_analysis_run.log
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


HERE = Path(__file__).parent


def _run(cmd: list[str], *, capture: bool = True,
         allow_exits: tuple[int, ...] = (0,)) -> str:
    """Run a subprocess; print its stdout/stderr; return stdout for parsing.

    `allow_exits` lists exit codes that are NOT errors. Default is just 0.
    Pass e.g. (0, 2) to tolerate calibrate_survival.py's exit-2 "no combo
    in band" path (bugbot #66 finding 11 — without this, the orchestrator's
    `_parse_calibrate_thresholds` spec-default fallback was unreachable).
    """
    print(f"\n$ {' '.join(cmd)}", flush=True)
    print("─" * 78, flush=True)
    if capture:
        proc = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE)
        sys.stdout.write(proc.stdout)
        if proc.stderr:
            sys.stderr.write(proc.stderr)
        if proc.returncode not in allow_exits:
            sys.exit(f"[run_v4_analysis] step failed (exit {proc.returncode}): {' '.join(cmd)}")
        return proc.stdout
    proc = subprocess.run(cmd, cwd=HERE)
    if proc.returncode not in allow_exits:
        sys.exit(f"[run_v4_analysis] step failed (exit {proc.returncode}): {' '.join(cmd)}")
    return ""


def _parse_calibrate_thresholds(out: str) -> tuple[int, float, float]:
    """Pull the recommended thresholds out of calibrate_survival.py output:

      ✓ Recommended gate (loosest in band):
        SURVIVED_HOLDERS_MIN = 1
        SURVIVED_LP_MIN_ETH  = 0.05
        SURVIVED_VOL_MIN_ETH = 0.0
    """
    # Accept negative floats too: VOL_THRESHOLDS_ETH includes a -1.0
    # "disable axis" sentinel (bugbot #66 finding 14), which the recommender
    # may emit verbatim as `SURVIVED_VOL_MIN_ETH = -1.0`.
    h = re.search(r"SURVIVED_HOLDERS_MIN\s*=\s*(\d+)", out)
    lp = re.search(r"SURVIVED_LP_MIN_ETH\s*=\s*(-?[\d.]+)", out)
    v = re.search(r"SURVIVED_VOL_MIN_ETH\s*=\s*(-?[\d.]+)", out)
    if not (h and lp and v):
        # Fallback: calibrate may have failed to find a combo in band. Use
        # spec defaults so the run still produces a report.
        sys.stderr.write(
            "[run_v4_analysis] calibrate_survival.py did not find a combo in "
            "the [30%, 70%] band — falling back to spec defaults "
            "(holders≥5, lp≥0.5, vol>0).\n"
        )
        return (5, 0.5, 0.0)
    return (int(h.group(1)), float(lp.group(1)), float(v.group(1)))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--corpus", required=True, help="Path to v4_corpus.csv")
    p.add_argument("--snapshot-log", required=True,
                   help="Path to /tmp/v4_snapshots.jsonl")
    p.add_argument("--report-out", default="REPORT.md",
                   help="Where pipeline.py should write its analysis report")
    p.add_argument("--target-low", type=float, default=0.30)
    p.add_argument("--target-high", type=float, default=0.70)
    args = p.parse_args(argv)

    corpus_path = (HERE / args.corpus).resolve() if not Path(args.corpus).is_absolute() else Path(args.corpus)
    snap_path = (HERE / args.snapshot_log).resolve() if not Path(args.snapshot_log).is_absolute() else Path(args.snapshot_log)
    if not corpus_path.exists():
        sys.exit(f"corpus not found: {corpus_path}")
    if not snap_path.exists():
        sys.stderr.write(f"warn: snapshot log not found: {snap_path}\n")

    print("=" * 78)
    print("Track-E v4 post-fetch analysis")
    print("=" * 78)
    print(f"  corpus       : {corpus_path}")
    print(f"  snapshot log : {snap_path}")
    print(f"  report out   : {args.report_out}")
    print(f"  band         : [{args.target_low:.0%}, {args.target_high:.0%}]")

    # Step 1: survival-gate calibration
    print("\n\n### STEP 1 — calibrate_survival.py ###")
    cal_out = _run([
        "uv", "run", "python3", "calibrate_survival.py",
        "--input", str(corpus_path),
        "--target-low", str(args.target_low),
        "--target-high", str(args.target_high),
    ], allow_exits=(0, 2))  # 2 = "no combo in band" → fall back to spec defaults
    holders, lp_eth, vol_eth = _parse_calibrate_thresholds(cal_out)
    print(f"\n→ Calibrated gate: holders≥{holders}, lp≥{lp_eth} ETH, vol>{vol_eth} ETH")

    # Step 2: pipeline (HP correlations + L2 fit + RF importance)
    print("\n\n### STEP 2 — pipeline.py ###")
    _run([
        "uv", "run", "python3", "pipeline.py",
        "--input", str(corpus_path),
        "--output", args.report_out,
        "--survived-holders-min", str(holders),
        "--survived-lp-min-eth", str(lp_eth),
        "--survived-vol-min-eth", str(vol_eth),
    ])

    # Step 3: diagnostic on the snapshot log
    print("\n\n### STEP 3 — diagnostic_hp_delta.py ###")
    if snap_path.exists():
        _run([
            "uv", "run", "python3", "diagnostic_hp_delta.py",
            "--log", str(snap_path),
            "--corpus", str(corpus_path),
        ])
    else:
        print(f"snapshot log absent ({snap_path}) — skip step 3")

    # Step 4: Marino cross-check
    print("\n\n### STEP 4 — marino_xcheck.py ###")
    _run([
        "uv", "run", "python3", "marino_xcheck.py",
        "--input", str(corpus_path),
        "--survived-holders-min", str(holders),
        "--survived-lp-min-eth", str(lp_eth),
        "--survived-vol-min-eth", str(vol_eth),
    ])

    print("\n\n" + "=" * 78)
    print("DONE — fill REPORT_v4_TEMPLATE.md → REPORT_v4.md by:")
    print("=" * 78)
    print("""
  Section 1 (corpus composition)     → from `corpus.csv` row count + the
                                       Phase 3 message in the fetch log
  Section 2 (survival-gate calib)    → from STEP 1 output above
  Section 3 (hp_delta diagnostic)    → from STEP 3 output above
  Section 4 (per-component analysis) → from pipeline.py's REPORT.md
  Section 5 (cross-validation):
    · Marino                         → from STEP 4 output above
    · wangr.com                      → manual: compare your survival rate
                                        against wangr.com's ~3-5% pump.fun
                                        baseline (sentence in REPORT_v4)
    · Validation cohort              → run validation_cohort.py separately
                                        + Spearman ρ between HP rank and
                                        FDV rank (manual notebook step)
  Section 6 (locked weights diff)    → JUDGMENT CALL: pick Scenario A or B
                                       based on the §4 + §5 numbers above
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
