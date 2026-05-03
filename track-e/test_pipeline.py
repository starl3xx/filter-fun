"""Unit tests for analysis-critical math.

Covers HHI score (spec §41.4–41.5 reference points) and the V4 full-range
WETH-side proxy used to populate `lp_depth_eth` / `lp_removed_24h_eth`. Both
have produced silent zero/garbage values in earlier corpus runs — locking the
formulas with fixtures keeps regressions visible.

Also includes a v4 static-analysis test (`test_no_leakage_inputs`) that
AST-walks pipeline.py and asserts no HP-component scorer reads from any
column named `outcome_*` or `survived_*`. This guards against accidental
leakage between component inputs and outcome labels — bugbot would catch
explicit `row.get("outcome_…")` calls in PR review, but a slow drift toward
helpers that pass-through rows is harder to spot manually.

Run: `uv run python3 test_pipeline.py` from track-e/.
"""

import ast
import json
import math
import sys
from pathlib import Path

import pandas as pd

from pipeline import hhi_score
from fetch_corpus import v4_full_range_weth_wei, hhi_score_from_balances


WETH = "0x4200000000000000000000000000000000000006"


def _row(balances: list[float]) -> pd.Series:
    return pd.Series({"holder_balances_json": json.dumps(balances)})


def test_hhi_one_holder_is_zero():
    # Single holder = perfect concentration → HHI=10000 → score 0.0
    assert hhi_score(_row([1.0])) == 0.0


def test_hhi_evenly_distributed_n100_is_half():
    # 100 equal holders → HHI = 10000 * 100 * (0.01)^2 = 100 → score 0.5
    # (spec §41.5 reference point: HHI=100 maps to 0.50)
    score = hhi_score(_row([1.0] * 100))
    assert abs(score - 0.5) < 1e-9, score


def test_hhi_evenly_distributed_n10000_is_one():
    # 10000 equal holders → HHI = 10000 * 10000 * (1e-4)^2 = 1.0 → score 1.0
    score = hhi_score(_row([1.0] * 10000))
    assert abs(score - 1.0) < 1e-9, score


def test_hhi_two_equal_holders():
    # Two equal holders → HHI = 10000 * 2 * 0.5^2 = 5000
    # score = 1 - log10(5000)/log10(10000) = 1 - 3.69897/4 = ~0.07526
    score = hhi_score(_row([50.0, 50.0]))
    expected = 1.0 - math.log10(5000.0) / 4.0
    assert abs(score - expected) < 1e-9, (score, expected)


def test_hhi_spec_reference_hhi_1000():
    # Construct a distribution with HHI ≈ 1000 → score should be ≈ 0.25.
    # 10 equal holders: HHI = 10000 * 10 * 0.1^2 = 1000.
    score = hhi_score(_row([1.0] * 10))
    assert abs(score - 0.25) < 1e-9, score


def test_hhi_spec_reference_hhi_100():
    # 100 equal holders → HHI=1, score=1.0; we need HHI=100 → 31.62 holders.
    # Use 32 equal: HHI = 10000 * 32 * (1/32)^2 = 10000/32 = 312.5 → score
    # = 1 - log10(312.5)/4 ≈ 0.378.
    score = hhi_score(_row([1.0] * 32))
    expected = 1.0 - math.log10(312.5) / 4.0
    assert abs(score - expected) < 1e-9, (score, expected)


def test_hhi_empty_or_missing_returns_zero():
    assert hhi_score(_row([])) == 0.0
    assert hhi_score(pd.Series({"holder_balances_json": ""})) == 0.0
    assert hhi_score(pd.Series({"holder_balances_json": "not json"})) == 0.0
    assert hhi_score(pd.Series({})) == 0.0


def test_hhi_dominant_whale():
    # 1 holder owns 90%, 9 own ~1.1% each → HHI dominated by the whale.
    # share^2 ≈ 0.81 + 9 * (0.0111)^2 ≈ 0.81 + 0.001 = 0.811 → HHI ≈ 8111.
    score = hhi_score(_row([90.0] + [1.111] * 9))
    assert score < 0.1, score  # very low — concentration penalty


def test_v4_full_range_weth_token1():
    # WETH = token1 case: amount1 ≈ L * sqrtP / 2^96
    # Pick a sane sqrtPriceX96 (~price 1e-12 → meme-coin worth 1e-12 ETH each)
    # so we cross-check both branches against each other.
    Q96 = 2 ** 96
    sqrtP = int(Q96 * 1e-6)  # price = 1e-12 (token0 → token1 ratio)
    L = 10 ** 18
    weth_wei = v4_full_range_weth_wei(L, sqrtP, target_is_token0=True)
    expected = (L * sqrtP) / Q96
    assert abs(weth_wei - expected) < 1.0, (weth_wei, expected)


def test_v4_full_range_weth_token0():
    # WETH = token0 case: amount0 ≈ L * 2^96 / sqrtP
    Q96 = 2 ** 96
    sqrtP = int(Q96 * 1e6)  # price = 1e12 (meme-coin > WETH)
    L = 10 ** 18
    weth_wei = v4_full_range_weth_wei(L, sqrtP, target_is_token0=False)
    expected = (L * Q96) / sqrtP
    assert abs(weth_wei - expected) < 1.0, (weth_wei, expected)


def test_v4_lp_depth_branches_yield_similar_weth_at_unit_price():
    # At sqrtP = 2^96 (price = 1, token0 == token1 in price terms), both
    # branches should yield the same WETH amount = L. This is the symmetry
    # check that the original buggy formula failed on tokens with addr > WETH.
    Q96 = 2 ** 96
    L = 10 ** 18
    a = v4_full_range_weth_wei(L, Q96, target_is_token0=True)
    b = v4_full_range_weth_wei(L, Q96, target_is_token0=False)
    assert abs(a - L) < 1.0, a
    assert abs(b - L) < 1.0, b
    assert abs(a - b) < 1.0, (a, b)


def test_hhi_fetcher_matches_pipeline():
    """fetch_corpus.hhi_score_from_balances and pipeline.hhi_score must
    produce identical outputs for the same distribution. Locks the two
    duplicated implementations against silent divergence — bumping one
    without the other would break HP trajectory consistency vs. the
    corpus-relative HHI score the pipeline computes.
    """
    fixtures = [
        [1.0],                       # 1 holder
        [50.0, 50.0],                # 2 equal
        [1.0] * 10,                  # 10 equal → HHI 1000
        [1.0] * 100,                 # 100 equal → HHI 100
        [1.0] * 10000,               # 10000 equal → HHI 1
        [90.0] + [1.111] * 9,        # whale-dominated
        [],                          # empty
        [1, 2, 3, 5, 8, 13, 21],     # fibonacci-ish
    ]
    for balances in fixtures:
        from_pipeline = hhi_score(_row(balances))
        # fetch_corpus expects pre-sorted balances list (matching how the
        # extractor calls it from `sorted(snap_at_filt.values(), reverse=True)`).
        from_fetcher = hhi_score_from_balances(sorted(balances, reverse=True))
        assert abs(from_pipeline - from_fetcher) < 1e-9, (
            f"divergence on {balances}: pipeline={from_pipeline}, "
            f"fetcher={from_fetcher}"
        )


def test_v4_lp_depth_token0_bug_regression():
    # Regression for the bug found in dev: a token with addr > WETH and a
    # high sqrtP (low meme-coin price relative to WETH) used to compute the
    # token-side instead of WETH-side, yielding billions of "ETH". The fixed
    # formula must produce a small WETH amount for token0=False with sqrtP > Q96.
    Q96 = 2 ** 96
    L = 10 ** 28  # mid-range V4 liquidity
    sqrtP = int(Q96 * 100.0)  # price ≈ 1e4 (token0 expensive in token1 units)
    weth_wei = v4_full_range_weth_wei(L, sqrtP, target_is_token0=False)
    # WETH-side amount = L / 100 = 1e26 wei = 1e8 ETH; the OLD formula would
    # have yielded L * sqrtP / Q96 = 1e30 wei = 1e12 ETH. Sanity is being
    # below the buggy result by 4 orders of magnitude.
    buggy = (L * sqrtP) / Q96
    assert weth_wei < buggy / 1000.0, (weth_wei, buggy)


SCORER_FUNCS = {
    "velocity_score",
    "effective_buyers_score",
    "sticky_liquidity_score",
    "retention_score",
    "momentum_score",
    "hhi_score",
    "compute_components",
}
LEAKAGE_PREFIXES = ("outcome_", "survived_")


def _string_args(node: ast.AST) -> list[str]:
    """Yield every string literal anywhere inside this AST node."""
    out: list[str] = []
    for sub in ast.walk(node):
        if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
            out.append(sub.value)
    return out


def test_no_leakage_inputs():
    """Walk pipeline.py and assert no HP-component scoring function references
    a column whose name starts with `outcome_` or `survived_`. The scorers
    are only allowed to read raw input fields — outcome columns belong to
    the analysis pass that runs *after* compute_components, never inside it.

    Detection is pessimistic: if a scorer mentions ANY string that has the
    leakage prefix (even in a comment that became a literal — unlikely), the
    test fails. False positives are easier to fix than missed leakage.
    """
    pipeline_path = Path(__file__).parent / "pipeline.py"
    tree = ast.parse(pipeline_path.read_text())
    leaks: list[tuple[str, str, int]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef):
            continue
        if node.name not in SCORER_FUNCS:
            continue
        for s in _string_args(node):
            if s.startswith(LEAKAGE_PREFIXES):
                leaks.append((node.name, s, node.lineno))
    assert not leaks, (
        "Found outcome-column references inside HP-component scorers — "
        "would create input/outcome leakage. Move the read into the "
        "outcome-derivation pass instead.\n  " + "\n  ".join(
            f"{fn} (line {ln}): refs '{s}'" for fn, s, ln in leaks
        )
    )


def test_no_leakage_inputs_catches_simulated_leak():
    """Meta-test: prove the AST walker actually fails when a scorer touches
    an outcome column. Builds a synthetic AST snippet and runs the same check
    in isolation so a stale walker can't silently let leakage through."""
    snippet = (
        "def velocity_score(row):\n"
        "    return row.get('outcome_30d_holder_retention', 0.0)\n"
    )
    tree = ast.parse(snippet)
    leaks: list[tuple[str, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name in SCORER_FUNCS:
            for s in _string_args(node):
                if s.startswith(LEAKAGE_PREFIXES):
                    leaks.append((node.name, s))
    assert leaks == [("velocity_score", "outcome_30d_holder_retention")], leaks


def main():
    fns = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    failures = []
    for fn in fns:
        try:
            fn()
            print(f"  ok  {fn.__name__}")
        except AssertionError as e:
            failures.append((fn.__name__, e))
            print(f"  FAIL {fn.__name__}: {e}")
    if failures:
        print(f"\n{len(failures)}/{len(fns)} tests failed")
        sys.exit(1)
    print(f"\n{len(fns)}/{len(fns)} tests passed")


if __name__ == "__main__":
    main()
