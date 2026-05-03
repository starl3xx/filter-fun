"""Track-E v4: validation cohort fetcher (top-25 by FDV per platform).

The dispatch's validation cohort tests whether the proposed §6.5 weights
place known winners at the top of the HP rank. We pick the top-25 tokens
by current FDV (price × supply) per launchpad, then run them through the
same `extract_token_features` path as the main corpus and report the
Spearman ρ between HP rank (under the proposed weights) and FDV rank.

Why FDV instead of cumulative volume or MCap: FDV is the most-watched
"this token won" metric on Base. Cumulative volume is biased toward
tokens with active scalpers; market cap requires circulating supply
which is poorly defined for V4 launches with locked LP. FDV (price ×
total supply) is the lowest-friction proxy for "the market thinks this
matters."

Algorithm:
  1. Discover all tokens from each launchpad in [start_days_ago, head]
     (uses the same discover_* functions as the main fetcher).
  2. For each token, fetch one PoolManager Swap log near head to read
     the most-recent sqrtPriceX96 (~1 RPC call/token; tokens with no
     swaps in the last 7d get FDV=0 and drop out automatically).
  3. Convert sqrtPriceX96 → price → FDV = price × token_supply.
  4. Sort by FDV desc, take top-25 per platform.
  5. Run extract_token_features on each (caches share with main corpus).
  6. Write `validation_corpus.csv` with the 50-token cohort + a
     `fdv_eth` column that downstream rank-correlation can use.

Run:
    uv run python3 validation_cohort.py --output validation_corpus.csv

Cost: ~600k CUs for FDV sampling + ~50 × 12k CUs for extraction = ~1.2M CUs.
"""

from __future__ import annotations

import argparse
import csv
import os
import random
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

from fetch_corpus import (
    BLOCKS_PER_DAY,
    BLOCKS_PER_HOUR,
    CACHE_DIR,
    CSV_COLUMNS,
    SWAP_SIG,
    V4_POOL_MANAGER_BASE,
    RpcClient,
    discover_liquid_tokens,
    discover_tokens,
    eth_call,
    extract_token_features,
    get_block_number,
    get_block_timestamp,
    get_chain_id,
    get_logs,
    hex_to_int,
    resolve_launch_timestamps,
    save_state,
    sqrtPriceX96_to_price,
    token_decimals,
    topic0,
    v4_full_range_weth_wei,
    write_corpus,
)

ENV_PATH = Path(__file__).parent / ".env"
CHAIN_ID_BASE = 8453


def _token_total_supply(rpc: RpcClient, token_addr: str) -> int:
    """ERC-20 totalSupply() — selector 0x18160ddd. Returns 0 on failure."""
    try:
        result = eth_call(rpc, token_addr, "0x18160ddd")
        if not result or result == "0x":
            return 0
        return hex_to_int(result)
    except Exception:
        return 0


def _latest_pool_state(rpc: RpcClient, pool_id: str, *, head: int,
                      lookback_blocks: int) -> dict | None:
    """Fetch the most-recent Swap log for `pool_id` within [head-lookback,
    head]. Returns dict with sqrtPriceX96 + liquidity, or None if no swaps."""
    fb = max(0, head - lookback_blocks)
    try:
        logs = get_logs(
            rpc,
            address=V4_POOL_MANAGER_BASE,
            topics=[topic0(SWAP_SIG), pool_id],
            from_block=fb,
            to_block=head,
        )
    except Exception:
        return None
    if not logs:
        return None
    last = logs[-1]
    # Lazy decode: we only need sqrtPriceX96 + liquidity from the data
    # (Swap layout: int128 amount0, int128 amount1, uint160 sqrtPriceX96,
    # uint128 liquidity, int24 tick, uint24 fee — non-indexed).
    from eth_abi import decode as abi_decode
    data = bytes.fromhex(last["data"][2:])
    a0, a1, sqrtP, liquidity, tick, fee = abi_decode(
        ["int128", "int128", "uint160", "uint128", "int24", "uint24"], data
    )
    return {
        "sqrtPriceX96": int(sqrtP),
        "liquidity": int(liquidity),
        "tick": int(tick),
        "block": hex_to_int(last["blockNumber"]),
    }


def _compute_fdv_eth(token_addr: str, state: dict, supply: int,
                     target_dec: int) -> float:
    """FDV in ETH = (price per whole token in WETH) × supply_in_whole_tokens.

    Tokens with non-18 decimals (rare on V4 launchpads but legal) need both
    a price-side and supply-side decimal correction. Bugbot #66 finding 6
    flagged the prior implementation that hardcoded 18 — for an 8-dec
    token this gave an FDV off by 10^10. The fetcher's `sqrtPriceX96_to_price`
    helper already does the correct decimal math; we delegate to it here.
    """
    if supply == 0 or not state or state["sqrtPriceX96"] == 0:
        return 0.0
    target_is_token0 = (
        token_addr.lower() < "0x4200000000000000000000000000000000000006"
    )
    price_per_whole_token_in_weth = sqrtPriceX96_to_price(
        state["sqrtPriceX96"], target_is_token0, target_dec=target_dec
    )
    supply_in_whole_tokens = supply / (10 ** target_dec)
    return price_per_whole_token_in_weth * supply_in_whole_tokens


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--output", default="validation_corpus.csv")
    p.add_argument("--start-days-ago", type=int, default=180,
                   help="Discovery window upper bound (older than this excluded)")
    p.add_argument("--end-days-ago", type=int, default=30,
                   help="Discovery window lower bound (newer than this excluded; "
                        "lets us require ≥30d of post-launch market activity)")
    p.add_argument("--top-n", type=int, default=25,
                   help="Number of top-FDV tokens to keep per platform")
    p.add_argument("--fdv-lookback-blocks", type=int, default=7 * BLOCKS_PER_DAY,
                   help="Blocks behind head to scan for the most-recent swap "
                        "(used to read current sqrtPriceX96). Default ~7d.")
    p.add_argument("--platforms", default="clanker,liquid",
                   help="Comma-separated list of platforms to include")
    p.add_argument("--max-candidates-per-platform", type=int, default=0,
                   help="Random-sample at most this many candidates per "
                        "platform before FDV scoring. 0 = scan all (the "
                        "docstring's ~1.2M CU estimate assumed ~50k Clanker "
                        "candidates; in practice Clanker V4 emits ~750k in a "
                        "150d window, which makes the exhaustive scan a "
                        "multi-day job. A random subsample of 2k–5k is a "
                        "reasonable proxy for top-25 by FDV.")
    p.add_argument("--seed", type=int, default=42,
                   help="RNG seed for the candidate subsample (reproducibility)")
    args = p.parse_args(argv)

    if ENV_PATH.exists():
        load_dotenv(ENV_PATH)
    rpc_url = os.environ.get("BASE_MAINNET_RPC_URL", "").strip()
    if not rpc_url or "<" in rpc_url:
        sys.exit("BASE_MAINNET_RPC_URL not set; see sources.md")

    rpc = RpcClient(url=rpc_url)
    chain = get_chain_id(rpc)
    if chain != CHAIN_ID_BASE:
        sys.exit(f"connected to chain {chain}, expected {CHAIN_ID_BASE}")

    head_block = get_block_number(rpc)
    head_ts = get_block_timestamp(rpc, head_block)
    start_ts = head_ts - args.start_days_ago * 86400
    end_ts = head_ts - args.end_days_ago * 86400

    from fetch_corpus import find_block_at_ts
    start_block = find_block_at_ts(rpc, start_ts, max(0, head_block - args.start_days_ago * BLOCKS_PER_DAY * 2), head_block)
    end_block = find_block_at_ts(rpc, end_ts, start_block, head_block)
    print(f"window: blocks [{start_block}, {end_block}]  "
          f"({args.start_days_ago}d → {args.end_days_ago}d ago)")

    platforms = [s.strip() for s in args.platforms.split(",") if s.strip()]
    state: dict = {}
    candidates: list[tuple[str, dict]] = []  # [(platform, token_dict)]

    if "clanker" in platforms:
        print(f"\nDiscovering Clanker V4 tokens…")
        clanker_tokens = discover_tokens(rpc, from_block=start_block,
                                          to_block=end_block, state=state)
        for t in clanker_tokens:
            t["platform"] = "clanker"
            candidates.append(("clanker", t))
        print(f"  {len(clanker_tokens)} Clanker candidates")

    if "liquid" in platforms:
        print(f"\nDiscovering Liquid V1 tokens…")
        liquid_tokens = discover_liquid_tokens(rpc, from_block=start_block,
                                                to_block=end_block, state=state)
        for t in liquid_tokens:
            candidates.append(("liquid", t))
        print(f"  {len(liquid_tokens)} Liquid candidates")

    if args.max_candidates_per_platform > 0:
        rng = random.Random(args.seed)
        by_plat: dict[str, list[tuple[str, dict]]] = {}
        for plat, tok in candidates:
            by_plat.setdefault(plat, []).append((plat, tok))
        sampled: list[tuple[str, dict]] = []
        for plat, items in by_plat.items():
            if len(items) > args.max_candidates_per_platform:
                items = rng.sample(items, args.max_candidates_per_platform)
                print(f"\n  subsampled {plat}: {args.max_candidates_per_platform} of "
                      f"{len(by_plat[plat])} (seed={args.seed})")
            sampled.extend(items)
        candidates = sampled

    print(f"\nFDV sampling for {len(candidates)} candidates "
          f"(lookback {args.fdv_lookback_blocks // BLOCKS_PER_DAY}d)…")
    fdvs: dict[str, float] = {}
    fdv_supplies: dict[str, int] = {}
    fdv_states: dict[str, dict] = {}
    t_start = time.monotonic()
    for i, (plat, tok) in enumerate(candidates):
        if i and i % 250 == 0:
            elapsed = time.monotonic() - t_start
            print(f"  [{i}/{len(candidates)}] {elapsed:.0f}s elapsed, "
                  f"{i / max(elapsed, 0.01):.1f} tok/s")
        addr = tok["token_address"]
        pool_id = tok.get("pool_id", "")
        if not pool_id or len(pool_id) != 66:
            continue
        state_at = _latest_pool_state(rpc, pool_id, head=head_block,
                                       lookback_blocks=args.fdv_lookback_blocks)
        if not state_at:
            continue
        supply = _token_total_supply(rpc, addr)
        if supply == 0:
            continue
        # bugbot #66 finding 6: read on-chain decimals instead of assuming
        # 18. token_decimals defaults to 18 on RPC failure, which is the
        # right default for V4 launchpads but doesn't silently mis-rank a
        # rare 8/9-decimal token.
        target_dec = token_decimals(rpc, addr)
        fdv = _compute_fdv_eth(addr, state_at, supply, target_dec=target_dec)
        if fdv > 0:
            fdvs[addr] = fdv
            fdv_supplies[addr] = supply
            fdv_states[addr] = state_at

    print(f"\n{len(fdvs)}/{len(candidates)} candidates have non-zero FDV in the lookback window")

    # Sort + take top N per platform
    by_platform: dict[str, list[tuple[str, dict]]] = {p: [] for p in platforms}
    for plat, tok in candidates:
        if tok["token_address"] in fdvs:
            by_platform.setdefault(plat, []).append((tok["token_address"], tok))
    cohort: list[dict] = []
    for plat in platforms:
        toks = by_platform.get(plat, [])
        toks.sort(key=lambda x: -fdvs[x[0]])
        topn = toks[: args.top_n]
        print(f"\nTop {len(topn)} {plat} tokens by FDV:")
        for addr, tok in topn:
            print(f"  {fdvs[addr]:>12.4f} ETH  {addr}  {tok.get('name', '')[:40]}")
            tok["_fdv_eth"] = fdvs[addr]  # stash for write step
            cohort.append(tok)

    if not cohort:
        print("\nNo tokens in cohort — bailing.")
        return 1

    # Resolve launch timestamps for the cohort, then extract features.
    print(f"\nResolving timestamps for {len(cohort)} cohort tokens…")
    resolve_launch_timestamps(rpc, cohort)

    print(f"\nExtracting features for {len(cohort)} cohort tokens (cache-shared with main corpus)…")
    CACHE_DIR.mkdir(exist_ok=True)
    extractions = []
    for i, tok in enumerate(cohort):
        addr = tok["token_address"]
        symbol = (tok.get("symbol") or "")[:12]
        prefix = f"  [{i+1}/{len(cohort)}]"
        print(f"{prefix} {symbol:<12} {addr}…", end="", flush=True)
        t0 = time.monotonic()
        try:
            ext = extract_token_features(rpc, tok, head_block=head_block)
        except Exception as e:
            print(f" FAILED ({e})")
            continue
        if ext is None:
            print(" skipped (non-WETH or invalid pool)")
            continue
        # Stash FDV on the extraction's notes field for the writer to pick
        # up — TokenExtraction has no fdv_eth slot and adding one would
        # ripple through CSV_COLUMNS + the cache schema. notes is the
        # designated free-form column.
        ext.notes = ((ext.notes + ";") if ext.notes else "") + \
                    f"validation_cohort:fdv_eth={tok['_fdv_eth']:.6f}"
        extractions.append(ext)
        dt = time.monotonic() - t0
        print(f" ✓ ({dt:.1f}s, fdv={tok['_fdv_eth']:.3f} ETH)")

    output_path = Path(args.output)
    write_corpus(extractions, output_path)
    print(f"\nWrote {len(extractions)} cohort tokens → {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
