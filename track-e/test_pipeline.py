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
from fetch_corpus import (
    decode_token_created,
    decode_liquid_token_created,
    v4_full_range_weth_wei,
    hhi_score_from_balances,
)


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


# Real on-chain TokenCreated log fixtures captured 2026-05-02 from Base
# mainnet. The "expected" addresses below were verified via eth_getCode on
# the captured topics: the token row has 12.7-12.9KB of bytecode (it's the
# deployed ERC-20), the deployer/admin row has 0-23 bytes (EOA or proxy).
# Bugbot #66 finding 5 caught a regression where the indexed-slot order was
# flipped in the decoder refactor — these fixtures lock the mapping.

CLANKER_LOG_FIXTURE = {
    "topics": [
        "0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67",
        "0x0000000000000000000000007533c2b35899d247837ca604cdf7931df015bfd1",
        "0x000000000000000000000000fc426dfeae55dae2f936a592450c9ecea87a5736",
    ],
    "data": "0x000000000000000000000000fc426dfeae55dae2f936a592450c9ecea87a573600000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000026000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000002e00000000000000000000000000000000000000000000000000000000000000480fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc7c00000000000000000000000000b429d62f8f3bffb98cdb9569533ea23bf0ba28ccf532cabe0219812826c4aaeba4c3b4db586529e065880e307acb58976ae9d5d3000000000000000000000000420000000000000000000000000000000000000600000000000000000000000063d2dfea64b3433f4071a98665bcd7ca14d93496000000000000000000000000ebb25bb797d82cb78e1bc70406b13233c085441300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000520000000000000000000000000000000000000000000000000000000000000006668747470733a2f2f6178696f6d74726164696e672e73666f332e63646e2e6469676974616c6f6365616e7370616365732e636f6d2f356366523975726356486d7457566f636d4267465539665262456f3870696d58314a48375772575870756d702e776562700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001343414e4345522050415449454e5420444f474500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a43414e434552444f47450000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001797b226465736372697074696f6e223a2243414e4345522050415449454e5420444f4745202d20636f6d6d756e697479206d656d6520746f6b656e206f6e20626173655c6e5c6e7b4c41554e43484544205749544820434c41574e4348205649412034434c41577d222c22736f6369616c4d6564696155726c73223a5b7b22706c6174666f726d223a2277656273697465222c2275726c223a2268747470733a2f2f782e636f6d2f42696c6c794d326b2f7374617475732f31383732343435363530323538303433303233227d2c7b22706c6174666f726d223a2234636c6177222c2275726c223a2268747470733a2f2f7777772e34636c61772e6f72672f742f62633266383037302d636338612d343561342d396365622d376461303466636465623363227d2c7b22706c6174666f726d223a2274776974746572222c2275726c223a2268747470733a2f2f782e636f6d2f42696c6c794d326b2f7374617475732f31383732343435363530323538303433303233227d5d7d00000000000000000000000000000000000000000000000000000000000000000000000000007f7b22696e74657266616365223a22436c61776e6368222c22706c6174666f726d223a2234636c6177222c226d6573736167654964223a227468726561643a62633266383037302d636338612d343561342d396365622d376461303466636465623363222c226964223a2234636c61775f616e6f6e5f7468726561643a62227d000000000000000000000000000000000000000000000000000000000000000000",
    "blockNumber": "0x2b62137",
    "transactionHash": "0x54515ab8a75fdda7d594abd46483f1d989c4ab9c41fd99ee47ed001d26fa2fc0",
}
CLANKER_EXPECTED_TOKEN = "0x7533c2b35899d247837ca604cdf7931df015bfd1"
CLANKER_EXPECTED_DEPLOYER = "0xfc426dfeae55dae2f936a592450c9ecea87a5736"

LIQUID_LOG_FIXTURE = {
    "topics": [
        "0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67",
        "0x00000000000000000000000040936afb2f15ecb588cf5c9519fce62b41c39fc0",
        "0x000000000000000000000000430d00d7b63715ff5f19c825b750aa20ce627c8b",
    ],
    "data": "0x000000000000000000000000430d00d7b63715ff5f19c825b750aa20ce627c8b00000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000026000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000002e00000000000000000000000000000000000000000000000000000000000000340fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc7c000000000000000000000000009811f10cd549c754fa9e5785989c422a762c28cc4ce1c73dc45976b74a21a9f671fdc9dc8e551bb6d7c9caea876f24d82b8df1aa000000000000000000000000420000000000000000000000000000000000000600000000000000000000000077247fcd1d5e34a3703aca898a591dc7422435f3000000000000000000000000187e8627c02c58f31831953c1268e157d3bfcefd000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003a0000000000000000000000000000000000000000000000000000000000000006c68747470733a2f2f7261696e626f776d652d7265732e636c6f7564696e6172792e636f6d2f696d6167652f75706c6f61642f76313737373637353730322f746f6b656e2d6c61756e636865722f746f6b656e732f773235326f697466636a7174696b37686a6173632e6a70670000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c5363726962626c65436f696e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000085343524942424c45000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003f7b226465736372697074696f6e223a2273637269626269667920796f757220696d6167652077697468207363726962626c652067656e657261746f7220227d00000000000000000000000000000000000000000000000000000000000000002b7b22696e74657266616365223a227261696e626f77222c22706c6174666f726d223a226c6971756964227d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "blockNumber": "0x2b5687f",
    "transactionHash": "0x27e9680ef2f5c0973defd7723bb149b9fbf5befe15062e0782f76d04a84139bc",
}
LIQUID_EXPECTED_TOKEN = "0x40936afb2f15ecb588cf5c9519fce62b41c39fc0"
LIQUID_EXPECTED_ADMIN = "0x430d00d7b63715ff5f19c825b750aa20ce627c8b"
LIQUID_EXPECTED_PAIRED = "0x4200000000000000000000000000000000000006"  # WETH


def test_decode_token_created_clanker_indexed_order():
    """Lock Clanker V4 indexed slot mapping: topic[1]=tokenAddress (the
    contract), topic[2]=msgSender (deployer EOA). Bugbot #66 finding 5
    flagged a regression where these were flipped — that swap broke
    every downstream feature that reads d['tokenAddress'].

    Clanker V4's ABI field naming is misleading: the contract emits the
    short ticker in `tokenName` and a description JSON in `tokenSymbol`
    (see fetch_corpus.py:619 — `ticker = token.get("name")` is what
    populates the corpus's `ticker` column, NOT `token.get("symbol")`).
    The fixture's actual emit confirms this — we assert it explicitly so
    the corpus's downstream ticker column doesn't silently break."""
    d = decode_token_created(CLANKER_LOG_FIXTURE)
    assert d["tokenAddress"] == CLANKER_EXPECTED_TOKEN, d["tokenAddress"]
    assert d["msgSender"] == CLANKER_EXPECTED_DEPLOYER, d["msgSender"]
    assert d.get("pairedToken", "").lower() == "0x4200000000000000000000000000000000000006"
    # The actual Clanker mapping: tokenName=short ticker, tokenSymbol=JSON.
    assert d.get("tokenName") == "CANCERDOGE", d.get("tokenName")
    assert d.get("tokenSymbol", "").startswith("{"), d.get("tokenSymbol", "")[:50]


def test_decode_token_created_liquid_indexed_order():
    """Lock Liquid V1 indexed slot mapping: topic[1]=tokenAddress (the
    contract), topic[2]=tokenAdmin. Liquid differs from Clanker in that
    topic[2] is an admin (could be EOA or contract proxy), not the
    msgSender — but topic[1] is consistently the deployed token."""
    d = decode_liquid_token_created(LIQUID_LOG_FIXTURE)
    assert d["tokenAddress"] == LIQUID_EXPECTED_TOKEN, d["tokenAddress"]
    assert d["tokenAdmin"] == LIQUID_EXPECTED_ADMIN, d["tokenAdmin"]
    assert d.get("pairedToken", "").lower() == LIQUID_EXPECTED_PAIRED
    assert d.get("tokenName") == "ScribbleCoin"
    assert d.get("tokenSymbol") == "SCRIBBLE"


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
