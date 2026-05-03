"""Track-E v4 Prereq 2: diagnostic for hp_delta_recent.

In v3 the corpus reported `hp_delta_recent == 0.0` for ~98% of tokens, which
collapsed the momentum component to a constant and made it unfittable. This
script consumes the per-snapshot HP component log emitted by
`fetch_corpus.py --snapshot-log <path>` and partitions tokens into one of
five buckets so we can see *why* the delta was zero:

  • `no_snapshots`         token never appeared in the log (likely cached
                           from a pre-v4 run; CACHE_SCHEMA bump would force
                           a re-extract — left to the operator).
  • `partial_<N>`           fewer than 4 snapshots were emitted (extraction
                           bailed early; usually because end_block <
                           launch+96h, i.e. a token launched too close to
                           head).
  • `all_zero`              4 snapshots present, but every component is 0.0
                           at every snapshot (truly dead-on-arrival — no
                           swaps, no holders to compare).
  • `flat_post_72h`         hp@72h ≈ hp@96h (delta within ±1e-9). Means the
                           token was active early but had no incremental
                           activity in the last 24h of the window.
  • `varying`               hp@72h vs hp@96h actually differs — the delta
                           should be informative for these.

Run after a fetch:
    uv run python3 fetch_corpus.py --pilot 250 --stratified \\
        --max-scan 5000 --snapshot-log /tmp/snapshots.jsonl
    uv run python3 diagnostic_hp_delta.py --log /tmp/snapshots.jsonl

If `flat_post_72h` dominates, the right fix is to widen the delta window
(e.g. (hp@96h − hp@48h) / hp@48h) or drop momentum from §6.5 entirely.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path


def _load_snapshots(log_path: Path) -> dict[str, dict[int, dict]]:
    """Parse the JSONL snapshot log into {token: {snapshot_hour: record}}."""
    by_token: dict[str, dict[int, dict]] = defaultdict(dict)
    with open(log_path) as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"  warn: skipping malformed line {line_no}: {e}", file=sys.stderr)
                continue
            if rec.get("event") != "hp_snapshot_computed":
                continue
            tok = rec.get("token")
            hour = rec.get("snapshot_hour")
            if tok and hour:
                by_token[tok][hour] = rec
    return dict(by_token)


def _classify(snaps: dict[int, dict]) -> str:
    hours = sorted(snaps.keys())
    if hours != [24, 48, 72, 96]:
        return f"partial_{len(hours)}"
    hp_vals = [snaps[h].get("hp_raw_5comp", 0.0) for h in hours]
    # Also check that no component is non-zero at any snapshot — even when HP
    # rolls up to 0, individual components may be informative.
    any_nonzero = False
    for h in hours:
        for v in (snaps[h].get("components") or {}).values():
            if isinstance(v, (int, float)) and v != 0:
                any_nonzero = True
                break
        if any_nonzero:
            break
    if not any_nonzero:
        return "all_zero"
    hp_72, hp_96 = hp_vals[2], hp_vals[3]
    if abs(hp_96 - hp_72) < 1e-9:
        return "flat_post_72h"
    return "varying"


def _format_traj(snaps: dict[int, dict]) -> str:
    parts = []
    for h in (24, 48, 72, 96):
        if h in snaps:
            hp = snaps[h].get("hp_raw_5comp", 0.0)
            ub = snaps[h].get("components", {}).get("unique_buyers_at", 0)
            parts.append(f"h{h}={hp:.4f}(b={ub})")
        else:
            parts.append(f"h{h}=—")
    return " ".join(parts)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--log", required=True, help="Path to snapshot JSONL log")
    p.add_argument("--corpus", default=None,
                   help="Optional path to corpus.csv to count tokens not "
                        "represented in the log (= cached, pre-snapshot-logging).")
    p.add_argument("--show-varying", type=int, default=5,
                   help="Print N example tokens from the 'varying' bucket "
                        "for quick eyeball validation (default 5).")
    args = p.parse_args(argv)

    log_path = Path(args.log)
    if not log_path.exists():
        print(f"error: log file not found: {log_path}", file=sys.stderr)
        return 1

    snapshots = _load_snapshots(log_path)
    print(f"loaded snapshot data for {len(snapshots)} tokens from {log_path}")

    buckets: dict[str, list[str]] = defaultdict(list)
    for tok, snaps in snapshots.items():
        buckets[_classify(snaps)].append(tok)

    if args.corpus:
        corpus_path = Path(args.corpus)
        if not corpus_path.exists():
            print(f"warn: corpus path missing: {corpus_path}", file=sys.stderr)
        else:
            import csv
            corpus_tokens: set[str] = set()
            with open(corpus_path) as cf:
                reader = csv.DictReader(cf)
                for row in reader:
                    addr = (row.get("token_address") or "").lower()
                    if addr:
                        corpus_tokens.add(addr)
            missing = corpus_tokens - set(snapshots.keys())
            buckets["no_snapshots"] = sorted(missing)
            print(f"corpus has {len(corpus_tokens)} tokens; "
                  f"{len(missing)} have no snapshot rows (cached or pre-v4)")

    total_classified = sum(len(v) for v in buckets.values())
    print(f"\nbucket distribution (n={total_classified}):")
    for bucket in ("no_snapshots", "partial_1", "partial_2", "partial_3",
                   "all_zero", "flat_post_72h", "varying"):
        if bucket not in buckets:
            continue
        n = len(buckets[bucket])
        pct = (n / total_classified * 100.0) if total_classified else 0.0
        print(f"  {bucket:18s} {n:5d}  ({pct:5.1f}%)")
    # Catch any "partial_N" bucket where N > 3 that we didn't pre-name.
    extras = sorted(b for b in buckets if b.startswith("partial_")
                    and b not in {"partial_1", "partial_2", "partial_3"})
    for bucket in extras:
        n = len(buckets[bucket])
        pct = (n / total_classified * 100.0) if total_classified else 0.0
        print(f"  {bucket:18s} {n:5d}  ({pct:5.1f}%)")

    varying = buckets.get("varying", [])
    if varying and args.show_varying > 0:
        print(f"\nsample from 'varying' bucket (n={len(varying)}):")
        for tok in varying[: args.show_varying]:
            print(f"  {tok}  {_format_traj(snapshots[tok])}")

    # Headline number for the v4 report.
    v_pct = (len(varying) / total_classified * 100.0) if total_classified else 0.0
    print(f"\n→ informative momentum signal: {len(varying)}/{total_classified} "
          f"tokens ({v_pct:.1f}%) have hp@72h ≠ hp@96h")
    return 0


if __name__ == "__main__":
    sys.exit(main())
