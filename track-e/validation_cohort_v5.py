"""Track-E v5: liquidity-first validation cohort fetcher.

PR #76 (`validation_cohort.py`) random-sampled candidate tokens then
FDV-filtered them. On the v4 corpus that returned n=7 instead of the
planned n=50: only ~0.14% of a 5,120-token random subsample had any
recent swap activity, so random sampling at 0.66% of a 765k-candidate
population can't recover top-25.

This script fixes that by inverting the funnel — scan ACTIVITY first,
then look up which active pools belong to our launchpads, then FDV-rank
those:

    1. Discover all Clanker V4 + Liquid V1 candidates over [start, end]
       (same window as v4). Build a `pool_id → (token_addr, platform)`
       index from the discovery output.
    2. Scan PoolManager Swap logs over the last `swap_window_days` days
       (default 7d). For each Swap, take topic[1] as `pool_id` and
       decode amount0/amount1 from the data payload.
    3. Filter to swaps whose pool_id is in the index from step 1.
       Group by pool_id; rank by swap count (primary) and total
       |amount0| + |amount1| (tie-breaker).
    4. Take top `--top-pools` (default 500) most-active pools. For each,
       FDV-sample using the same decimals-correct path as PR #76
       (`current_price_via_sqrtPriceX96 × supply`).
    5. Group by platform; sort by FDV desc; take top-N (default 25)
       per platform → cohort.
    6. Resolve launch timestamps + extract features (cache shared with
       the main corpus). FDV gets stashed in the `notes` column the
       same way the v4 script did so `validate_hp_rank.py` reads it
       unchanged.
    7. Write `validation_corpus_v5.csv`.

Estimated runtime: ~15-30 min vs PR #76's ~40 min that returned n=7.

Run:
    uv run python3 validation_cohort_v5.py \\
        --output validation_corpus_v5.csv \\
        --swap-window-days 7 \\
        --top-pools 500 \\
        --top-n 25
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

from dotenv import load_dotenv

from fetch_corpus import (
    BLOCKS_PER_DAY,
    CACHE_DIR,
    SWAP_SIG,
    V4_POOL_MANAGER_BASE,
    RpcClient,
    discover_liquid_tokens,
    discover_tokens,
    extract_token_features,
    find_block_at_ts,
    get_block_number,
    get_block_timestamp,
    get_chain_id,
    get_logs,
    hex_to_int,
    resolve_launch_timestamps,
    save_state,
    topic0,
    write_corpus,
)

# Reuse PR #76's FDV helpers verbatim — single source of truth. Bugbot
# #76 finding 6 lives in `_compute_fdv_eth` (decimals-correct math),
# and we don't want to risk re-deriving that.
from validation_cohort import (
    _compute_fdv_eth,
    _latest_pool_state,
    _token_total_supply,
)
from fetch_corpus import token_decimals

ENV_PATH = Path(__file__).parent / ".env"
CHAIN_ID_BASE = 8453


def _decode_swap_amounts(log: dict) -> tuple[int, int]:
    """Decode amount0 + amount1 from a V4 Swap log's data payload.

    Layout (non-indexed): int128 amount0, int128 amount1, uint160
    sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee. We only
    need the two amounts for activity ranking; the rest of the data
    is parsed elsewhere when we FDV-sample.
    """
    from eth_abi import decode as abi_decode
    data = bytes.fromhex(log["data"][2:])
    a0, a1, _sqrtP, _liq, _tick, _fee = abi_decode(
        ["int128", "int128", "uint160", "uint128", "int24", "uint24"], data,
    )
    return int(a0), int(a1)


def _scan_active_pools(
    rpc: RpcClient,
    *,
    pool_index: dict[str, tuple[str, dict]],
    from_block: int,
    to_block: int,
) -> dict[str, dict]:
    """Walk PoolManager Swap logs over [from_block, to_block] and return
    `{pool_id: {swap_count, abs_amount_total, last_block}}` for pool_ids
    that appear in `pool_index`.

    `pool_index` is {pool_id_lower → (platform, token_dict)}. We filter
    in Python rather than passing the pool_ids as a topic[1] filter
    because the candidate set has ~half a million pool_ids and the RPC
    won't accept that many disjuncts.
    """
    swap_t0 = topic0(SWAP_SIG)
    print(f"  scanning PoolManager Swap logs in [{from_block}, {to_block}] "
          f"({(to_block - from_block + 1)} blocks)…", flush=True)
    t_start = time.monotonic()
    logs = get_logs(rpc, address=V4_POOL_MANAGER_BASE,
                    topics=[swap_t0], from_block=from_block, to_block=to_block)
    print(f"  fetched {len(logs):,} Swap logs in {time.monotonic() - t_start:.1f}s",
          flush=True)

    activity: dict[str, dict] = defaultdict(lambda: {
        "swap_count": 0, "abs_amount_total": 0, "last_block": 0,
    })
    matched = 0
    for log in logs:
        topics = log.get("topics") or []
        if len(topics) < 2:
            continue
        pool_id = topics[1].lower()  # bytes32
        if pool_id not in pool_index:
            continue
        try:
            a0, a1 = _decode_swap_amounts(log)
        except Exception:
            continue
        bn = hex_to_int(log["blockNumber"])
        e = activity[pool_id]
        e["swap_count"] += 1
        e["abs_amount_total"] += abs(a0) + abs(a1)
        if bn > e["last_block"]:
            e["last_block"] = bn
        matched += 1
    print(f"  {matched:,} swaps matched a known launchpad pool "
          f"({len(activity):,} unique active pools)", flush=True)
    return dict(activity)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--output", default="validation_corpus_v5.csv")
    p.add_argument("--start-days-ago", type=int, default=180,
                   help="Discovery window upper bound (older than this excluded)")
    p.add_argument("--end-days-ago", type=int, default=30,
                   help="Discovery window lower bound (newer than this excluded; "
                        "lets us require ≥30d of post-launch market activity)")
    p.add_argument("--swap-window-days", type=int, default=7,
                   help="How far back to scan PoolManager Swap logs for the "
                        "liquidity-first activity rank (default 7d)")
    p.add_argument("--top-pools", type=int, default=500,
                   help="How many top-active pools to FDV-sample after the "
                        "activity rank (default 500). Larger = more coverage "
                        "but more RPC cost.")
    p.add_argument("--top-n", type=int, default=25,
                   help="Number of top-FDV tokens to keep per platform")
    p.add_argument("--fdv-lookback-blocks", type=int, default=7 * BLOCKS_PER_DAY,
                   help="Blocks behind head to scan for the most-recent swap "
                        "(used to read current sqrtPriceX96). Default ~7d.")
    p.add_argument("--platforms", default="clanker,liquid",
                   help="Comma-separated list of platforms to include")
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

    start_block = find_block_at_ts(
        rpc, start_ts,
        max(0, head_block - args.start_days_ago * BLOCKS_PER_DAY * 2),
        head_block,
    )
    end_block = find_block_at_ts(rpc, end_ts, start_block, head_block)
    print(f"discovery window: blocks [{start_block}, {end_block}]  "
          f"({args.start_days_ago}d → {args.end_days_ago}d ago)")

    swap_from = max(0, head_block - args.swap_window_days * BLOCKS_PER_DAY)
    print(f"swap-activity window: blocks [{swap_from}, {head_block}]  "
          f"(last {args.swap_window_days}d)")

    platforms = [s.strip() for s in args.platforms.split(",") if s.strip()]
    state: dict = {}

    # Step 1 — discover all candidate tokens; build pool_id → (platform, tok) index.
    candidates: list[tuple[str, dict]] = []
    if "clanker" in platforms:
        print(f"\nDiscovering Clanker V4 tokens…")
        clanker_tokens = discover_tokens(rpc, from_block=start_block,
                                          to_block=end_block, state=state)
        for t in clanker_tokens:
            t["platform"] = "clanker"
            candidates.append(("clanker", t))
        print(f"  {len(clanker_tokens):,} Clanker candidates")

    if "liquid" in platforms:
        print(f"\nDiscovering Liquid V1 tokens…")
        liquid_tokens = discover_liquid_tokens(rpc, from_block=start_block,
                                                to_block=end_block, state=state)
        for t in liquid_tokens:
            candidates.append(("liquid", t))
        print(f"  {len(liquid_tokens):,} Liquid candidates")

    pool_index: dict[str, tuple[str, dict]] = {}
    n_no_pool = 0
    for plat, tok in candidates:
        pool_id = (tok.get("pool_id") or "").lower()
        if not pool_id or len(pool_id) != 66:
            n_no_pool += 1
            continue
        pool_index[pool_id] = (plat, tok)
    print(f"\npool_id index: {len(pool_index):,} pools "
          f"({n_no_pool:,} candidates dropped — missing/invalid pool_id)")

    # Step 2 — liquidity-first scan.
    print(f"\nScanning PoolManager activity…")
    activity = _scan_active_pools(
        rpc,
        pool_index=pool_index,
        from_block=swap_from,
        to_block=head_block,
    )

    if not activity:
        print("\nNo activity matched any known launchpad pool — bailing.")
        return 1

    # Step 3 — rank pools, take top-N most-active.
    ranked = sorted(
        activity.items(),
        key=lambda kv: (kv[1]["swap_count"], kv[1]["abs_amount_total"]),
        reverse=True,
    )
    top_pools = ranked[: args.top_pools]
    print(f"\nTop {len(top_pools)} most-active pools selected for FDV sampling.")
    if top_pools:
        ex_pid, ex_act = top_pools[0]
        plat, _ = pool_index[ex_pid]
        print(f"  example #1: pool {ex_pid[:10]}…  platform={plat}  "
              f"swaps={ex_act['swap_count']:,}")

    # Step 4 — FDV-sample the top-N.
    print(f"\nFDV sampling for {len(top_pools)} candidates "
          f"(lookback {args.fdv_lookback_blocks // BLOCKS_PER_DAY}d)…")
    fdvs: dict[str, float] = {}
    fdv_supplies: dict[str, int] = {}
    fdv_states: dict[str, dict] = {}
    fdv_meta: dict[str, dict] = {}  # tok dict + platform per token addr
    t0 = time.monotonic()
    for i, (pool_id, _act) in enumerate(top_pools):
        if i and i % 50 == 0:
            elapsed = time.monotonic() - t0
            print(f"  [{i}/{len(top_pools)}] {elapsed:.0f}s elapsed, "
                  f"{i / max(elapsed, 0.01):.1f} pool/s", flush=True)
        plat, tok = pool_index[pool_id]
        addr = tok["token_address"]
        state_at = _latest_pool_state(rpc, pool_id, head=head_block,
                                       lookback_blocks=args.fdv_lookback_blocks)
        if not state_at:
            continue
        supply = _token_total_supply(rpc, addr)
        if supply == 0:
            continue
        target_dec = token_decimals(rpc, addr)
        fdv = _compute_fdv_eth(addr, state_at, supply, target_dec=target_dec)
        if fdv > 0:
            fdvs[addr] = fdv
            fdv_supplies[addr] = supply
            fdv_states[addr] = state_at
            fdv_meta[addr] = {"platform": plat, "tok": tok}

    print(f"\n{len(fdvs)}/{len(top_pools)} active-pool tokens have non-zero FDV "
          f"(of which {sum(1 for m in fdv_meta.values() if m['platform']=='clanker')} "
          "Clanker, "
          f"{sum(1 for m in fdv_meta.values() if m['platform']=='liquid')} Liquid)")

    # Step 5 — top-N per platform.
    by_platform: dict[str, list[tuple[str, dict]]] = {p: [] for p in platforms}
    for addr, meta in fdv_meta.items():
        by_platform.setdefault(meta["platform"], []).append((addr, meta["tok"]))

    cohort: list[dict] = []
    for plat in platforms:
        toks = by_platform.get(plat, [])
        toks.sort(key=lambda x: -fdvs[x[0]])
        topn = toks[: args.top_n]
        print(f"\nTop {len(topn)} {plat} tokens by FDV:")
        for addr, tok in topn:
            print(f"  {fdvs[addr]:>12.4f} ETH  {addr}  {tok.get('name', '')[:40]}")
            tok["_fdv_eth"] = fdvs[addr]
            tok["platform"] = plat
            cohort.append(tok)

    if not cohort:
        print("\nNo tokens in cohort — bailing.")
        return 1

    # Step 6 — resolve timestamps + extract features.
    print(f"\nResolving timestamps for {len(cohort)} cohort tokens…")
    resolve_launch_timestamps(rpc, cohort)

    print(f"\nExtracting features for {len(cohort)} cohort tokens "
          "(cache-shared with main corpus)…")
    CACHE_DIR.mkdir(exist_ok=True)
    extractions = []
    for i, tok in enumerate(cohort):
        addr = tok["token_address"]
        symbol = (tok.get("symbol") or "")[:12]
        prefix = f"  [{i+1}/{len(cohort)}]"
        print(f"{prefix} {symbol:<12} {addr}…", end="", flush=True)
        t_ext = time.monotonic()
        try:
            ext = extract_token_features(rpc, tok, head_block=head_block)
        except Exception as e:
            print(f" FAILED ({e})")
            continue
        if ext is None:
            print(" skipped (non-WETH or invalid pool)")
            continue
        # Stash FDV on notes — same convention as PR #76 so
        # validate_hp_rank.py picks it up unchanged.
        ext.notes = ((ext.notes + ";") if ext.notes else "") + \
                    f"validation_cohort:fdv_eth={tok['_fdv_eth']:.6f}"
        extractions.append(ext)
        print(f" ✓ ({time.monotonic() - t_ext:.1f}s, fdv={tok['_fdv_eth']:.3f} ETH)")

    output_path = (Path(__file__).parent / args.output).resolve() \
        if not Path(args.output).is_absolute() else Path(args.output)
    write_corpus(extractions, output_path)
    save_state(state)
    print(f"\nWrote {len(extractions)} cohort tokens → {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
