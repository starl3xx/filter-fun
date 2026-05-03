#!/usr/bin/env python3
"""
Track E — real-data corpus fetcher (Clanker V4 on Base mainnet).

Crawls historical token launches from Clanker V4 (0xE85A…83a9), the only
Clanker factory active in the 6-month-to-90-day target window. Earlier
Clanker versions (V1–V3.5) are dormant per the verification scan in
sources.md — they emit zero events in this window.

Extracts HP-component inputs at launch+96h and forward-replays for outcome
labels at 30d/60d/90d. Output is a CSV at track-e/corpus.csv that validates
against pipeline.py.

Uses JSON-RPC against an Alchemy Base mainnet endpoint. Set
BASE_MAINNET_RPC_URL in track-e/.env (gitignored — see sources.md).

Usage:
    uv run python3 fetch_corpus.py --pilot 10        # 10-token pilot
    uv run python3 fetch_corpus.py                   # full crawl
    uv run python3 fetch_corpus.py --reset           # clear state + cache

The fetcher is idempotent: state lives at track-e/.fetch_state.json. Per-token
extractions are cached at track-e/.fetch_cache/<token>.json.

V4-specific design notes:
    - Pool state (sqrtPriceX96) is read directly from each Swap event, so we
      avoid needing the V4 StateView lens contract.
    - lp_depth_eth is approximated as net WETH inflow via swaps + LP adds in
      the launch→t+96h window. This is a proxy, not a literal pool balance,
      because V4 PoolManager holds currency totals across all pools (no
      per-pool WETH reserve to query directly).
    - lp_removed_24h_eth uses ModifyLiquidity events with liquidityDelta < 0,
      approximating WETH-side via the live sqrtPriceX96 at each event.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import random
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import requests
from dotenv import load_dotenv
from eth_abi import decode as abi_decode
from eth_utils import keccak

HERE = Path(__file__).resolve().parent
ENV_PATH = HERE / ".env"
STATE_PATH = HERE / ".fetch_state.json"
CACHE_DIR = HERE / ".fetch_cache"
CORPUS_PATH = HERE / "corpus.csv"
DISCOVERED_PATH = HERE / "discovered_tokens.csv"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CHAIN_ID_BASE = 8453
WETH_BASE = "0x4200000000000000000000000000000000000006"
V4_POOL_MANAGER_BASE = "0x498581ff718922c3f8e6a244956af099b2652b2b"
ZERO = "0x0000000000000000000000000000000000000000"
DEAD = "0x000000000000000000000000000000000000dead"

KNOWN_NON_HOLDER_ADDRESSES = {
    a.lower() for a in [
        ZERO, DEAD, WETH_BASE, V4_POOL_MANAGER_BASE,
        "0xDef1C0ded9bec7F1a1670819833240f027b25EfF",  # 0x router
        # Liquid Protocol locker contracts (per app.liquidprotocol.org/docs).
        # Excluded from holder counts so locked LP balances don't masquerade
        # as concentrated retail holders in HHI per spec §41.3.
        "0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF",  # LiquidFeeLocker
        "0x77247fCD1d5e34A3703AcA898A591Dc7422435f3",  # LiquidLpLockerFeeConversion
    ]
}

BASE_BLOCK_TIME_S = 2.0
BLOCKS_PER_DAY = int(86400 / BASE_BLOCK_TIME_S)
BLOCKS_PER_HOUR = int(3600 / BASE_BLOCK_TIME_S)

# Default 5-component HP weights (no momentum) used to score the per-token
# trajectory at intra-window snapshots [t+24h,+48h,+72h,+96h]. Renormalized
# from spec §6.5 defaults (30/15/20/15/10/10) by dropping the momentum slot
# and rescaling the remainder to sum to 1.0.
HP_5COMP_WEIGHTS = {
    "velocity": 30 / 90,
    "effectiveBuyers": 15 / 90,
    "stickyLiquidity": 20 / 90,
    "retention": 15 / 90,
    "holderConcentration": 10 / 90,
}

# Survival gate at t+168h (one full filter.fun week, the closest retrospective
# proxy to "would have made the h96 cut"). Track-E v3 dispatch: closer to the
# actionable signal than the existing 30/60/90d outcome labels.
SURVIVED_HOLDERS_MIN = 5
SURVIVED_LP_MIN_ETH = 0.5
SURVIVED_VOL_MIN_ETH = 0.0  # strict positivity — any swap volume in the trailing 24h


# ---------------------------------------------------------------------------
# Clanker V4 factory + event ABI
# ---------------------------------------------------------------------------

CLANKER_V4_ADDRESS = "0xE85A59c628F7d27878ACeB4bf3b35733630083a9"

# event TokenCreated(
#   address indexed msgSender,
#   address indexed tokenAddress,
#   address tokenAdmin,
#   string tokenMetadata, string tokenImage, string tokenName,
#   string tokenSymbol, string tokenContext,
#   int24 startingTick, address poolHook, bytes32 poolId,
#   address pairedToken, address locker, address mevModule,
#   uint256 extensionsSupply, address[] extensions
# );
# Sig hash verified against the on-chain topic0 0x9299d1d1… on Base mainnet.
TOKEN_CREATED_SIG = (
    "TokenCreated(address,address,address,string,string,string,string,string,"
    "int24,address,bytes32,address,address,address,uint256,address[])"
)
# Indexed slots (msgSender, tokenAddress) → 2 topics after topic0.
# Non-indexed (in data, in order):
NONINDEXED_TYPES = [
    "address",  # tokenAdmin
    "string", "string", "string", "string", "string",
    "int24", "address", "bytes32",
    "address", "address", "address",
    "uint256", "address[]",
]
NONINDEXED_NAMES = [
    "tokenAdmin",
    "tokenMetadata", "tokenImage", "tokenName", "tokenSymbol", "tokenContext",
    "startingTick", "poolHook", "poolId",
    "pairedToken", "locker", "mevModule",
    "extensionsSupply", "extensions",
]

# ---------------------------------------------------------------------------
# Liquid V1 factory + event ABI
# ---------------------------------------------------------------------------
#
# Verified 2026-05-02 against Sourcify partial-match for Liquid.sol::ILiquid.
# Topic0 = keccak("TokenCreated(...)") below = 0x9299d1d1… which is the
# dominant log topic on the factory (2,613 events lifetime as of head 45.49M).
# Pairs into the same V4 PoolManager as Clanker — only discovery + locker
# exclusions are launchpad-specific.

LIQUID_V1_ADDRESS = "0x04F1a284168743759BE6554f607a10CEBdB77760"

LIQUID_TOKEN_CREATED_SIG = (
    "TokenCreated(address,address,address,string,string,string,string,string,"
    "int24,address,bytes32,address,address,address,uint256,address[])"
)
# Indexed: tokenAddress (topic[1]), tokenAdmin (topic[2]).
# Non-indexed slot order differs from Clanker's (image/name/symbol/metadata vs
# metadata/image/name/symbol) — separate name list to keep decoders distinct.
LIQUID_NONINDEXED_TYPES = [
    "address",  # msgSender
    "string", "string", "string", "string", "string",
    "int24", "address", "bytes32",
    "address", "address", "address",
    "uint256", "address[]",
]
LIQUID_NONINDEXED_NAMES = [
    "msgSender",
    "tokenImage", "tokenName", "tokenSymbol", "tokenMetadata", "tokenContext",
    "startingTick", "poolHook", "poolId",
    "pairedToken", "locker", "mevModule",
    "extensionsSupply", "extensions",
]


# Uniswap V4 PoolManager events
# event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
SWAP_SIG = "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"
SWAP_NONINDEXED = ["int128", "int128", "uint160", "uint128", "int24", "uint24"]

# event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)
MODIFY_LIQ_SIG = "ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"
MODIFY_LIQ_NONINDEXED = ["int24", "int24", "int256", "bytes32"]

# ERC-20 Transfer
TRANSFER_SIG = "Transfer(address,address,uint256)"


def topic0(sig: str) -> str:
    return "0x" + keccak(text=sig).hex()


# ---------------------------------------------------------------------------
# JSON-RPC client (rate-limited, retrying)
# ---------------------------------------------------------------------------

class RPCError(Exception):
    pass


@dataclass
class RpcClient:
    url: str
    min_interval_s: float = 0.04
    max_retries: int = 6
    _last_call: float = 0.0
    _session: requests.Session = field(default_factory=requests.Session)
    _request_id: int = 0

    def _throttle(self):
        gap = time.monotonic() - self._last_call
        if gap < self.min_interval_s:
            time.sleep(self.min_interval_s - gap)
        self._last_call = time.monotonic()

    def call(self, method: str, params: list) -> object:
        for attempt in range(self.max_retries):
            self._throttle()
            self._request_id += 1
            payload = {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": method,
                "params": params,
            }
            try:
                resp = self._session.post(self.url, json=payload, timeout=60)
            except requests.RequestException as e:
                self._backoff(attempt, f"network: {e}")
                continue
            if resp.status_code == 429:
                self._backoff(attempt, "429 rate limited")
                continue
            if resp.status_code >= 500:
                self._backoff(attempt, f"{resp.status_code}")
                continue
            try:
                body = resp.json()
            except ValueError:
                self._backoff(attempt, "non-json")
                continue
            if "error" in body:
                msg = str(body["error"])
                if "log response size exceeded" in msg.lower() or "limit exceeded" in msg.lower():
                    raise RPCError(f"log_limit:{msg}")
                if any(s in msg.lower() for s in ("timeout", "temporarily", "503")):
                    self._backoff(attempt, msg)
                    continue
                raise RPCError(f"{method}: {msg}")
            return body.get("result")
        raise RPCError(f"{method}: exhausted retries")

    def _backoff(self, attempt: int, reason: str):
        wait = min(60.0, 0.5 * (2 ** attempt))
        time.sleep(wait)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def hex_to_int(h) -> int:
    if isinstance(h, int):
        return h
    return int(h, 16)


def topic_to_address(topic: str) -> str:
    return "0x" + topic[-40:]


def get_chain_id(rpc: RpcClient) -> int:
    return hex_to_int(rpc.call("eth_chainId", []))


def get_block_number(rpc: RpcClient) -> int:
    return hex_to_int(rpc.call("eth_blockNumber", []))


def get_block_timestamp(rpc: RpcClient, block: int) -> int:
    res = rpc.call("eth_getBlockByNumber", [hex(block), False])
    if not res:
        raise RPCError(f"no block at {block}")
    return hex_to_int(res["timestamp"])


def find_block_at_ts(rpc: RpcClient, target_ts: int, lo: int, hi: int) -> int:
    while lo < hi - 1:
        mid = (lo + hi) // 2
        ts = get_block_timestamp(rpc, mid)
        if ts < target_ts:
            lo = mid
        else:
            hi = mid
    return lo


def eth_call(rpc: RpcClient, to: str, data: str, block="latest") -> str:
    blk = hex(block) if isinstance(block, int) else block
    return rpc.call("eth_call", [{"to": to, "data": data}, blk])


def get_logs(rpc: RpcClient, *, address, topics: list, from_block: int, to_block: int) -> list[dict]:
    """eth_getLogs with auto-chunking on log_limit errors."""
    out: list[dict] = []

    def crawl(a: int, b: int):
        try:
            logs = rpc.call(
                "eth_getLogs",
                [{
                    "fromBlock": hex(a),
                    "toBlock": hex(b),
                    "address": address,
                    "topics": topics,
                }],
            ) or []
            out.extend(logs)
        except RPCError as e:
            if str(e).startswith("log_limit") and b > a:
                mid = (a + b) // 2
                crawl(a, mid)
                crawl(mid + 1, b)
            else:
                raise

    chunk = 50000
    cur = from_block
    while cur <= to_block:
        end = min(cur + chunk - 1, to_block)
        crawl(cur, end)
        cur = end + 1
    return out


def token_decimals(rpc: RpcClient, token: str) -> int:
    sel = "0x313ce567"  # decimals()
    try:
        res = eth_call(rpc, token, sel)
        return hex_to_int(res) if res and res != "0x" else 18
    except RPCError:
        return 18


# ---------------------------------------------------------------------------
# Decoders
# ---------------------------------------------------------------------------

def _decode_token_created(
    log: dict,
    *,
    indexed_names: list[str],
    nonindexed_types: list[str],
    nonindexed_names: list[str],
) -> dict:
    """Generic TokenCreated decoder shared by Clanker V4 + Liquid V1.

    The two factories emit the same logical event with the same field types
    but in different orders + with different `indexed` choices. Centralizing
    the decode keeps the bytes/poolId/UTF-8 handling in one place so a fix
    in one path can't silently leave the other broken (bugbot #66 finding 4).

    `indexed_names`: ordered list of names for topic[1], topic[2], …
    `nonindexed_types` / `nonindexed_names`: the data-blob fields, in ABI
        decoder order. Names beginning with `poolId` get hex-encoded; other
        bytes get UTF-8 decoded with error replacement, falling back to hex.
    """
    out: dict = {}
    for i, name in enumerate(indexed_names):
        out[name] = topic_to_address(log["topics"][i + 1]).lower()
    data = bytes.fromhex(log["data"][2:])
    values = abi_decode(nonindexed_types, data)
    for name, val in zip(nonindexed_names, values):
        if isinstance(val, bytes):
            if name == "poolId":
                out[name] = "0x" + val.hex()
            else:
                try:
                    out[name] = val.decode("utf-8", errors="replace")
                except Exception:
                    out[name] = "0x" + val.hex()
        else:
            out[name] = val
    return out


def decode_token_created(log: dict) -> dict:
    # Clanker V4 indexed slots verified empirically on Base mainnet:
    # topic[1] is the deployed ERC-20 (eth_getCode returns ~12.8KB of
    # bytecode); topic[2] is the deployer EOA (eth_getCode returns "0x").
    # Bugbot #66 finding 5 caught a regression where the refactor flipped
    # the order — see test_decode_token_created_indexed_order which now
    # locks this against future regressions.
    return _decode_token_created(
        log,
        indexed_names=["tokenAddress", "msgSender"],
        nonindexed_types=NONINDEXED_TYPES,
        nonindexed_names=NONINDEXED_NAMES,
    )


def decode_liquid_token_created(log: dict) -> dict:
    # Liquid V1 indexed slots: tokenAddress (topic[1]), tokenAdmin (topic[2])
    # — verified against the canonical Sourcify ABI for Liquid.sol::ILiquid.
    # Differs from Clanker V4 which indexes msgSender + tokenAddress.
    return _decode_token_created(
        log,
        indexed_names=["tokenAddress", "tokenAdmin"],
        nonindexed_types=LIQUID_NONINDEXED_TYPES,
        nonindexed_names=LIQUID_NONINDEXED_NAMES,
    )


def decode_swap(log: dict) -> dict:
    pool_id = log["topics"][1]  # bytes32
    sender = topic_to_address(log["topics"][2])
    data = bytes.fromhex(log["data"][2:])
    a0, a1, sqrtP, liquidity, tick, fee = abi_decode(SWAP_NONINDEXED, data)
    return {
        "poolId": pool_id,
        "sender": sender,
        "amount0": a0, "amount1": a1,
        "sqrtPriceX96": sqrtP, "liquidity": liquidity, "tick": tick, "fee": fee,
        "block": hex_to_int(log["blockNumber"]),
        "tx": log["transactionHash"],
        "log_index": hex_to_int(log["logIndex"]),
    }


def decode_modify_liquidity(log: dict) -> dict:
    pool_id = log["topics"][1]
    data = bytes.fromhex(log["data"][2:])
    tick_lo, tick_hi, liq_delta, salt = abi_decode(MODIFY_LIQ_NONINDEXED, data)
    return {
        "poolId": pool_id,
        "tickLower": tick_lo, "tickUpper": tick_hi,
        "liquidityDelta": liq_delta,
        "block": hex_to_int(log["blockNumber"]),
    }


def decode_transfer(log: dict) -> dict:
    return {
        "from": topic_to_address(log["topics"][1]),
        "to": topic_to_address(log["topics"][2]),
        "amount": hex_to_int(log["data"]),
        "block": hex_to_int(log["blockNumber"]),
    }


# ---------------------------------------------------------------------------
# V4 pricing helpers
# ---------------------------------------------------------------------------

def sqrtPriceX96_to_price(sqrtP: int, target_is_token0: bool, target_dec: int = 18) -> float:
    """Returns price of target denominated in WETH (both ETH-units, decimal-adjusted)."""
    if sqrtP == 0:
        return 0.0
    p_raw = (sqrtP / (2 ** 96)) ** 2  # token1/token0 in raw units
    if target_is_token0:
        # target=token0, WETH=token1 → price(target in WETH) = p_raw, scaled by decimals
        return p_raw * (10 ** (target_dec - 18))
    else:
        return (1.0 / p_raw) * (10 ** (target_dec - 18))


def amount0_from_swap_to_eth(swap: dict, target_is_token0: bool) -> float:
    """Return signed ETH-side change for the swapper from this swap.

    Positive = swapper sent ETH in (a buy of target). Negative = swapper got ETH out.
    Both amount0/amount1 are signed: positive means the swapper sent it in.
    """
    if target_is_token0:
        return swap["amount1"] / 1e18  # WETH = token1
    else:
        return swap["amount0"] / 1e18  # WETH = token0


def target_amount_signed(swap: dict, target_is_token0: bool) -> int:
    return swap["amount0"] if target_is_token0 else swap["amount1"]


# ---------------------------------------------------------------------------
# Phase 1: discovery
# ---------------------------------------------------------------------------

def _discover_from_factory(
    rpc: RpcClient,
    *,
    factory_addr: str,
    sig: str,
    decoder,
    platform: str,
    version: str,
    log_label: str,
    state_key: str,
    from_block: int,
    to_block: int,
    state: dict,
) -> list[dict]:
    """Generic factory-log → token-dict scanner shared by Clanker V4 + Liquid
    V1 (bugbot #66 finding 4: deduplicate `discover_*` so output-dict shape
    can't drift between launchpads). Discovery is intentionally NOT
    checkpointed — full re-scan is cheap; per-token caches handle resume."""
    sig_topic = topic0(sig)
    print(f"  [{log_label}] crawling {from_block} → {to_block} ({(to_block - from_block) // 1000}k blocks)")
    logs = get_logs(rpc, address=factory_addr, topics=[sig_topic],
                    from_block=from_block, to_block=to_block)
    print(f"  [{log_label}] {len(logs)} TokenCreated events")

    out: list[dict] = []
    for log in logs:
        try:
            d = decoder(log)
        except Exception as e:
            print(f"    decode fail: {e}")
            continue
        block = hex_to_int(log["blockNumber"])
        out.append({
            "token_address": d["tokenAddress"],
            "deployer": d.get("msgSender", ""),
            "platform": platform,
            "version": version,
            "name": d.get("tokenName", ""),
            "symbol": d.get("tokenSymbol", ""),
            "pool_id": d.get("poolId", ""),
            "paired_token": d.get("pairedToken", "").lower() if isinstance(d.get("pairedToken"), str) else "",
            "locker": d.get("locker", "").lower() if isinstance(d.get("locker"), str) else "",
            "starting_tick": d.get("startingTick", 0),
            "launch_block": block,
            "tx_hash": log["transactionHash"],
        })

    out.sort(key=lambda t: t["launch_block"])
    seen: set[str] = set()
    deduped: list[dict] = []
    for t in out:
        if t["token_address"] in seen:
            continue
        seen.add(t["token_address"])
        deduped.append(t)
    state[f"discover.{state_key}.last_scan_blocks"] = [from_block, to_block]
    state[f"discover.{state_key}.last_scan_count"] = len(deduped)
    return deduped


def discover_tokens(rpc: RpcClient, *, from_block: int, to_block: int, state: dict) -> list[dict]:
    """Scan Clanker V4 factory logs for TokenCreated events in
    [from_block, to_block]. Thin platform-specific wrapper around
    `_discover_from_factory`."""
    return _discover_from_factory(
        rpc,
        factory_addr=CLANKER_V4_ADDRESS,
        sig=TOKEN_CREATED_SIG,
        decoder=decode_token_created,
        platform="clanker",
        version="V4",
        log_label="V4",
        state_key="V4",
        from_block=from_block,
        to_block=to_block,
        state=state,
    )


def discover_liquid_tokens(rpc: RpcClient, *, from_block: int, to_block: int, state: dict) -> list[dict]:
    """Scan Liquid V1 factory logs for TokenCreated events in
    [from_block, to_block]. Thin platform-specific wrapper around
    `_discover_from_factory`."""
    return _discover_from_factory(
        rpc,
        factory_addr=LIQUID_V1_ADDRESS,
        sig=LIQUID_TOKEN_CREATED_SIG,
        decoder=decode_liquid_token_created,
        platform="liquid",
        version="V1",
        log_label="Liquid V1",
        state_key="LiquidV1",
        from_block=from_block,
        to_block=to_block,
        state=state,
    )


def resolve_launch_timestamps(rpc: RpcClient, tokens: list[dict]) -> None:
    """Backfill `launch_ts` for the given tokens. Caller is responsible for
    capping the list to avoid 10k+ block-timestamp lookups during pilot runs."""
    if not tokens:
        return
    block_set = sorted({t["launch_block"] for t in tokens})
    ts_cache: dict[int, int] = {}
    print(f"  resolving timestamps for {len(block_set)} blocks…")
    for b in block_set:
        ts_cache[b] = get_block_timestamp(rpc, b)
    for t in tokens:
        t["launch_ts"] = ts_cache[t["launch_block"]]


# ---------------------------------------------------------------------------
# Per-token feature + outcome extraction
# ---------------------------------------------------------------------------

@dataclass
class TokenExtraction:
    token_address: str
    ticker: str
    name: str
    chain: str
    platform: str
    creator_address: str
    launch_ts: int
    launch_block: int
    t_window_hours: int
    total_buy_volume_eth: float = 0.0
    total_buy_volume_eth_decayed: float = 0.0
    unique_buyers: int = 0
    buyer_volumes_eth_json: str = "[]"
    lp_depth_eth: float = 0.0
    lp_removed_24h_eth: float = 0.0
    early_holders_count: int = 0
    early_holders_still_holding: int = 0
    hp_delta_recent: float = 0.0
    holder_count: int = 0
    holder_balances_json: str = "[]"
    outcome_30d_holder_retention: int = 0
    outcome_30d_price_floor: int = 0
    outcome_30d_volume_slope: int = 0
    outcome_30d_composite: int = 0
    outcome_60d_holder_retention: int = 0
    outcome_60d_price_floor: int = 0
    outcome_60d_volume_slope: int = 0
    outcome_60d_composite: int = 0
    outcome_90d_holder_retention: int = 0
    outcome_90d_price_floor: int = 0
    outcome_90d_volume_slope: int = 0
    outcome_90d_composite: int = 0
    # Track-E v3 additions
    survived_to_day_7: int = 0       # binary, on-chain only
    hp_trajectory_json: str = "[]"   # 5-comp raw HP at [+24h,+48h,+72h,+96h]
    # Track-E v4: raw 168h gate components, exposed so survived_to_day_7 can
    # be recalibrated post-hoc to land in the [30%, 70%] true-rate band per
    # the v4 dispatch (without re-running the multi-hour Alchemy crawl). The
    # binary `survived_to_day_7` column is whatever the at-fetch-time gate
    # decided; pipeline.py can recompute it from these three columns + new
    # thresholds.
    holders_at_168h: int = 0
    lp_depth_168h_eth: float = 0.0
    vol_24h_at_168h_eth: float = 0.0
    notes: str = ""
    # Cache-schema fingerprint. Bump when extraction semantics change so stale
    # caches written by an earlier code version get re-extracted instead of
    # silently producing degenerate values in the corpus.
    cache_schema: int = 6


CACHE_SCHEMA = 6


def hhi_score_from_balances(balances: list[int]) -> float:
    """HHI(balances) → 0-1 concentration score. Mirrors pipeline.hhi_score so
    snapshot HP in the fetcher matches the corpus-level scoring math."""
    total = sum(balances)
    if total <= 0 or len(balances) == 0:
        return 0.0
    shares = [b / total for b in balances]
    hhi = 10000.0 * sum(s * s for s in shares)
    return max(0.0, min(1.0, 1.0 - math.log10(max(hhi, 1.0)) / math.log10(10000.0)))


def hp_raw_5comp(velocity_eth_decayed: float,
                 sum_sqrt_buyer_volumes: float,
                 lp_depth_eth_at: float,
                 lp_removed_eth_at: float,
                 retention_frac: float,
                 hhi_concentration_score: float) -> float:
    """5-component raw HP at a snapshot. Used for the per-token trajectory and
    hp_delta_recent. Raw (un-percentile-ranked) by necessity — corpus context
    isn't available inside per-token extraction. Velocity + effectiveBuyers +
    stickyLiquidity are unbounded so the absolute value isn't comparable
    across tokens, but intra-token deltas are well-defined."""
    sticky = max(0.0, lp_depth_eth_at - lp_removed_eth_at)
    return (
        HP_5COMP_WEIGHTS["velocity"] * velocity_eth_decayed
        + HP_5COMP_WEIGHTS["effectiveBuyers"] * sum_sqrt_buyer_volumes
        + HP_5COMP_WEIGHTS["stickyLiquidity"] * sticky
        + HP_5COMP_WEIGHTS["retention"] * retention_frac
        + HP_5COMP_WEIGHTS["holderConcentration"] * hhi_concentration_score
    )


def v4_full_range_weth_wei(liquidity: int, sqrtPriceX96: int, target_is_token0: bool) -> float:
    """V4 full-range proxy: convert (L, sqrtP) → WETH-side amount in wei.

    Picks the correct currency side based on which token in the pair is WETH.
    When the meme-coin is token0 (target_is_token0=True), WETH is token1 and
    amount1 ≈ L · sqrtP / 2^96. When the meme-coin is token0=False, WETH is
    token0 and amount0 ≈ L · 2^96 / sqrtP. Mixing these up gives the meme-coin
    amount instead of WETH — off by ~price (often many orders of magnitude).
    """
    Q96 = 2 ** 96
    if target_is_token0:
        return (liquidity * sqrtPriceX96) / Q96
    return (liquidity * Q96) / sqrtPriceX96


def extract_token_features(
    rpc: RpcClient,
    token: dict,
    *,
    head_block: int,
    snapshot_log_fp=None,
) -> TokenExtraction | None:
    addr = token["token_address"]
    cache_path = CACHE_DIR / f"{addr}.json"
    if cache_path.exists():
        try:
            with open(cache_path) as f:
                cached = json.load(f)
            if cached.get("cache_schema") == CACHE_SCHEMA:
                return TokenExtraction(**cached)
            cache_path.unlink()  # stale → re-extract
        except Exception:
            cache_path.unlink()

    pool_id = token.get("pool_id", "")
    if not pool_id or len(pool_id) != 66:
        return None

    paired = (token.get("paired_token") or WETH_BASE).lower()
    if paired != WETH_BASE.lower():
        # Skip non-WETH-paired tokens for v1 (rare; would need a paired-token-USD oracle to compare)
        return None

    launch_block = token["launch_block"]
    launch_ts = token["launch_ts"]
    blk_24h = launch_block + 24 * BLOCKS_PER_HOUR
    blk_48h = launch_block + 48 * BLOCKS_PER_HOUR
    blk_72h = launch_block + 72 * BLOCKS_PER_HOUR
    blk_96h = launch_block + 96 * BLOCKS_PER_HOUR
    blk_168h = launch_block + 168 * BLOCKS_PER_HOUR  # 7d, for survived_to_day_7
    blk_30d = launch_block + 30 * BLOCKS_PER_DAY
    blk_60d = launch_block + 60 * BLOCKS_PER_DAY
    blk_90d = launch_block + 90 * BLOCKS_PER_DAY
    end_block = min(blk_90d, head_block)
    if end_block <= launch_block:
        return None

    # token0 vs token1 in V4: lower address is currency0
    target_is_token0 = addr.lower() < WETH_BASE.lower()
    target_dec = token_decimals(rpc, addr)

    # Clanker V4 stores arbitrary JSON in `tokenSymbol`; the human-readable
    # ticker lives in `tokenName`. Use that for the ticker column.
    ticker = (token.get("name") or "")[:12]
    ext = TokenExtraction(
        token_address=addr,
        ticker=ticker,
        name=(token.get("name") or "")[:64],
        chain="base",
        platform=(token.get("platform") or "clanker"),
        creator_address=token.get("deployer", ""),
        launch_ts=launch_ts,
        launch_block=launch_block,
        t_window_hours=96,
    )

    # ----- Swap events on PoolManager filtered by poolId -----
    swap_logs = get_logs(
        rpc, address=V4_POOL_MANAGER_BASE,
        topics=[topic0(SWAP_SIG), pool_id],
        from_block=launch_block, to_block=end_block,
    )
    swaps = [decode_swap(l) for l in swap_logs]

    if not swaps:
        ext.notes = "no swaps in 90d"
        CACHE_DIR.mkdir(exist_ok=True)
        with open(cache_path, "w") as f:
            json.dump(ext.__dict__, f)
        return ext

    # Compute swap-derived features at t+96h. velocity windowing for momentum
    # is handled below in the multi-snapshot HP loop (Track-E v3 Fix 2); the
    # v2 buy-velocity-rate formula was removed in this PR.
    buyer_volumes: dict[str, float] = defaultdict(float)
    total_buy = 0.0
    decayed_buy = 0.0
    last_swap_in_window: dict | None = None  # for V4 LP-depth proxy

    for sw in swaps:
        if sw["block"] > blk_96h:
            continue
        eth_signed = amount0_from_swap_to_eth(sw, target_is_token0)
        target_signed = target_amount_signed(sw, target_is_token0)
        # In V4: positive amount = swapper sent in. So buy of target: WETH-side > 0, target-side < 0.
        if eth_signed > 0 and target_signed < 0:
            wallet = sw["sender"]
            buyer_volumes[wallet] += eth_signed
            total_buy += eth_signed
            days_before_t96 = (blk_96h - sw["block"]) / BLOCKS_PER_DAY
            decayed_buy += eth_signed * math.exp(-0.5 * max(0.0, days_before_t96))
        if last_swap_in_window is None or sw["block"] > last_swap_in_window["block"]:
            last_swap_in_window = sw

    ext.total_buy_volume_eth = round(total_buy, 6)
    ext.total_buy_volume_eth_decayed = round(decayed_buy, 6)
    ext.unique_buyers = len(buyer_volumes)
    ext.buyer_volumes_eth_json = json.dumps([round(v, 6) for v in sorted(buyer_volumes.values(), reverse=True)])

    # V4 LP-depth proxy: post-swap pool liquidity from the latest swap before t+96h,
    # mapped to the WETH side via the full-range identity (see v4_full_range_weth_wei).
    # NB: net swap flow ≈ 0 by design (price discovery is roughly symmetric); the
    # quantity that actually represents "depth" is the locked pool liquidity, which
    # V4 emits with every Swap event in the `liquidity` field.
    if last_swap_in_window and last_swap_in_window["liquidity"] > 0 and last_swap_in_window["sqrtPriceX96"] > 0:
        weth_wei = v4_full_range_weth_wei(
            last_swap_in_window["liquidity"],
            last_swap_in_window["sqrtPriceX96"],
            target_is_token0,
        )
        ext.lp_depth_eth = round(weth_wei / 1e18, 6)

    # ----- ModifyLiquidity (LP) events: full launch→96h window, with
    # cumulative-by-block index so we can read "removed in 24h prior to <snap>"
    # at any snapshot block (used by survived_to_day_7 + hp trajectory). The
    # canonical lp_removed_24h_eth is "in [launch, t+24h]" per spec, capturing
    # creator/early-LP withdrawals that signal a rug-style launch.
    mod_logs_full = get_logs(
        rpc, address=V4_POOL_MANAGER_BASE,
        topics=[topic0(MODIFY_LIQ_SIG), pool_id],
        from_block=launch_block, to_block=min(blk_168h + 1, end_block),
    )
    burn_events: list[dict] = []  # [{block, weth_eth_removed}]
    if mod_logs_full and swaps:
        for log in mod_logs_full:
            ev = decode_modify_liquidity(log)
            if ev["liquidityDelta"] >= 0:
                continue
            nearest = min(swaps, key=lambda s: abs(s["block"] - ev["block"]))
            sqrtP = nearest["sqrtPriceX96"]
            if sqrtP <= 0:
                continue
            removed_liq = -ev["liquidityDelta"]
            weth_amt = v4_full_range_weth_wei(removed_liq, sqrtP, target_is_token0) / 1e18
            burn_events.append({"block": ev["block"], "weth_eth": weth_amt})
    burn_events.sort(key=lambda e: e["block"])

    def lp_removed_in_24h_pre(snap_block: int) -> float:
        lo = snap_block - 24 * BLOCKS_PER_HOUR
        return sum(b["weth_eth"] for b in burn_events if lo <= b["block"] <= snap_block)

    # spec: lp_removed_24h_eth is in the FIRST 24h after launch (rug indicator).
    ext.lp_removed_24h_eth = round(
        sum(b["weth_eth"] for b in burn_events if launch_block <= b["block"] <= blk_24h),
        6,
    )

    # ----- Token Transfer events for holder snapshots -----
    transfer_logs = get_logs(
        rpc, address=addr, topics=[topic0(TRANSFER_SIG)],
        from_block=launch_block, to_block=end_block,
    )

    # Track-E v3: snapshot at every 24h tick through the launch week so we
    # can build the HP trajectory + survived_to_day_7 from a single Transfer
    # log replay. blk_48h and blk_72h are needed for HP@72h vs HP@96h delta;
    # blk_168h is the survival gate.
    snapshot_blocks = sorted({
        blk_24h, blk_48h, blk_72h, blk_96h, blk_168h,
        blk_30d, blk_60d, blk_90d, end_block,
    })
    snapshot_blocks = [s for s in snapshot_blocks if s <= end_block]
    snapshots: dict[int, dict[str, int]] = {}
    balances: dict[str, int] = defaultdict(int)
    si = 0

    for log in transfer_logs:
        ev = decode_transfer(log)
        while si < len(snapshot_blocks) and ev["block"] > snapshot_blocks[si]:
            snapshots[snapshot_blocks[si]] = {k: v for k, v in balances.items() if v > 0}
            si += 1
        if ev["from"] != ZERO:
            balances[ev["from"]] -= ev["amount"]
            if balances[ev["from"]] <= 0:
                balances.pop(ev["from"], None)
        if ev["to"] != ZERO:
            balances[ev["to"]] += ev["amount"]
    while si < len(snapshot_blocks):
        snapshots[snapshot_blocks[si]] = {k: v for k, v in balances.items() if v > 0}
        si += 1

    pool_token_holder = V4_POOL_MANAGER_BASE.lower()  # PoolManager holds pool tokens

    def filtered(snap: dict[str, int]) -> dict[str, int]:
        excl = set(KNOWN_NON_HOLDER_ADDRESSES) | {pool_token_holder}
        if token.get("locker"):
            excl.add(token["locker"].lower())
        unit = 10 ** target_dec
        return {a: bal for a, bal in snap.items() if a not in excl and bal > unit}

    snap_24h = snapshots.get(blk_24h, {})
    snap_96h = snapshots.get(blk_96h, {})
    snap_24h_filt = filtered(snap_24h)
    snap_96h_filt = filtered(snap_96h)

    ext.early_holders_count = len(snap_24h_filt)
    early_set = set(snap_24h_filt.keys())
    ext.early_holders_still_holding = sum(1 for a in early_set if a in snap_96h_filt)
    ext.holder_count = len(snap_96h_filt)
    # HHI is scale-invariant; store raw counts for stable JSON
    ext.holder_balances_json = json.dumps(sorted(snap_96h_filt.values(), reverse=True))

    # ----- Multi-snapshot HP trajectory (Track-E v3 dispatch Fix 2) -----
    # Compute the 5-component raw HP at each of [t+24h, t+48h, t+72h, t+96h]
    # using already-fetched logs (no extra RPC). hp_delta_recent is then the
    # normalized (HP@96 − HP@72) / max(HP@72, ε) clipped to [-1,1]. The full
    # 4-point trajectory is stored as JSON for follow-up analysis.
    #
    # CAVEAT: this is the RAW 5-component HP (un-percentile-ranked, no
    # momentum component). pipeline.py's corpus-relative HP differs by
    # rank-normalizing velocity/effectiveBuyers/stickyLiquidity across the
    # corpus. The intra-token delta is well-defined regardless.
    snap_pts = [blk_24h, blk_48h, blk_72h, blk_96h]
    hp_traj: list[float] = []
    swaps_sorted = sorted(swaps, key=lambda s: s["block"])
    for snap_b in snap_pts:
        # Velocity + effectiveBuyers from cumulative buys ≤ snap_b
        buyers_at: dict[str, float] = defaultdict(float)
        v_decayed = 0.0
        for sw in swaps_sorted:
            if sw["block"] > snap_b:
                break
            eth_signed = amount0_from_swap_to_eth(sw, target_is_token0)
            tgt_signed = target_amount_signed(sw, target_is_token0)
            if eth_signed > 0 and tgt_signed < 0:
                buyers_at[sw["sender"]] += eth_signed
                days_before = (snap_b - sw["block"]) / BLOCKS_PER_DAY
                v_decayed += eth_signed * math.exp(-0.5 * max(0.0, days_before))
        sum_sqrt = sum(math.sqrt(max(0.0, v)) for v in buyers_at.values())

        # LP depth at snap_b: first swap of the highest block ≤ snap_b. The
        # strict `>` matches `last_swap_in_window` above (used to populate
        # ext.lp_depth_eth) so trajectory@96h's stickyLiquidity component
        # reads the same pool state as the published lp_depth_eth field.
        last_sw_pre = None
        for sw in swaps_sorted:
            if sw["block"] > snap_b:
                break
            if last_sw_pre is None or sw["block"] > last_sw_pre["block"]:
                last_sw_pre = sw
        depth_at = 0.0
        if last_sw_pre and last_sw_pre["liquidity"] > 0 and last_sw_pre["sqrtPriceX96"] > 0:
            depth_at = v4_full_range_weth_wei(
                last_sw_pre["liquidity"], last_sw_pre["sqrtPriceX96"], target_is_token0
            ) / 1e18
        removed_at = lp_removed_in_24h_pre(snap_b)

        # Retention: only meaningful from t+48h onward (t+24h sets the early
        # cohort). At t+24h, retention is 1.0 if the cohort is non-empty —
        # but 0.0 if there are no holders at all (a dead launch shouldn't
        # contribute the retention component's full weight to its hp_raw).
        snap_at_filt = filtered(snapshots.get(snap_b, {}))
        if not early_set:
            retention_at = 0.0
        elif snap_b == blk_24h:
            retention_at = 1.0
        else:
            retention_at = sum(1 for a in early_set if a in snap_at_filt) / len(early_set)

        hhi_at = hhi_score_from_balances(sorted(snap_at_filt.values(), reverse=True))

        hp = hp_raw_5comp(v_decayed, sum_sqrt, depth_at, removed_at, retention_at, hhi_at)
        hp_traj.append(round(hp, 6))

        # v4 diagnostic_hp_delta.py consumer: per-snapshot HP component dump.
        # Only emitted when the caller passes --snapshot-log; cached tokens
        # skip the snapshot loop entirely so they won't appear in the log
        # (diagnostic script treats absence as "no fresh data this run").
        if snapshot_log_fp is not None:
            snap_hour = {blk_24h: 24, blk_48h: 48, blk_72h: 72, blk_96h: 96}[snap_b]
            snapshot_log_fp.write(json.dumps({
                "event": "hp_snapshot_computed",
                "token": addr,
                "snapshot_hour": snap_hour,
                "block_number": snap_b,
                "components": {
                    "velocity_decayed_eth": round(v_decayed, 8),
                    "effective_buyers_sum_sqrt": round(sum_sqrt, 8),
                    "lp_depth_eth": round(depth_at, 8),
                    "lp_removed_24h_eth": round(removed_at, 8),
                    "retention": round(retention_at, 6),
                    "hhi_score": round(hhi_at, 6),
                    "unique_buyers_at": len(buyers_at),
                },
                "hp_raw_5comp": round(hp, 6),
            }) + "\n")

    ext.hp_trajectory_json = json.dumps(hp_traj)
    hp_72 = hp_traj[2]
    hp_96 = hp_traj[3]
    if hp_72 > 1e-9 or hp_96 > 1e-9:
        delta = (hp_96 - hp_72) / max(hp_72, 1e-9)
        ext.hp_delta_recent = round(max(-1.0, min(1.0, delta)), 4)
    # else: leave at 0.0 default — no HP signal in the t+72h→t+96h window

    # ----- survived_to_day_7 (Track-E v3 dispatch Fix 4d) -----
    # On-chain proxy for "would have made the filter.fun h96 cut": at t+168h
    # the token must still have ≥5 holders, ≥0.5 ETH liquidity, and at least
    # one swap in the trailing 24h. Pure on-chain — no thresholds vs. peak.
    if blk_168h <= head_block:
        snap_168h = filtered(snapshots.get(blk_168h, {}))
        # 168h LP depth: first swap of the highest block ≤ blk_168h. Uses
        # the same strict-`>` convention as last_swap_in_window and the
        # trajectory loop so survived_to_day_7's depth check is consistent
        # with the rest of the fetcher's LP-depth reads.
        last_sw_168 = None
        for sw in swaps_sorted:
            if sw["block"] > blk_168h:
                break
            if last_sw_168 is None or sw["block"] > last_sw_168["block"]:
                last_sw_168 = sw
        depth_168 = 0.0
        if last_sw_168 and last_sw_168["liquidity"] > 0 and last_sw_168["sqrtPriceX96"] > 0:
            depth_168 = v4_full_range_weth_wei(
                last_sw_168["liquidity"], last_sw_168["sqrtPriceX96"], target_is_token0
            ) / 1e18
        # trailing 24h swap volume (any direction — buys + sells) per the
        # spec for survived_to_day_7. WETH-side magnitude captures both:
        # buys send WETH in (eth_v > 0), sells take WETH out (eth_v < 0);
        # |eth_v| sums them as total flow either way.
        lo_168 = blk_168h - 24 * BLOCKS_PER_HOUR
        vol_24h_168 = 0.0
        for sw in swaps_sorted:
            if sw["block"] < lo_168 or sw["block"] > blk_168h:
                continue
            eth_v = amount0_from_swap_to_eth(sw, target_is_token0)
            if eth_v != 0:
                vol_24h_168 += abs(eth_v)
        # v4: persist the raw gate components so the threshold can be
        # recalibrated post-hoc to land in [30%, 70%] true-rate band per the
        # v4 dispatch (without re-fetching).
        ext.holders_at_168h = len(snap_168h)
        ext.lp_depth_168h_eth = round(depth_168, 6)
        ext.vol_24h_at_168h_eth = round(vol_24h_168, 6)
        if (
            len(snap_168h) >= SURVIVED_HOLDERS_MIN
            and depth_168 >= SURVIVED_LP_MIN_ETH
            and vol_24h_168 > SURVIVED_VOL_MIN_ETH
        ):
            ext.survived_to_day_7 = 1

    # ----- Outcome labels -----
    sample_interval = 7 * BLOCKS_PER_DAY
    sample_blocks = list(range(launch_block + sample_interval, end_block + 1, sample_interval))
    if not sample_blocks:
        sample_blocks = [end_block]

    # Holder count over time (re-replay with sample boundaries)
    bal2: dict[str, int] = defaultdict(int)
    sample_holder_counts: dict[int, int] = {}
    si2 = 0
    for log in transfer_logs:
        ev = decode_transfer(log)
        while si2 < len(sample_blocks) and ev["block"] > sample_blocks[si2]:
            sample_holder_counts[sample_blocks[si2]] = len(filtered({k: v for k, v in bal2.items() if v > 0}))
            si2 += 1
        if ev["from"] != ZERO:
            bal2[ev["from"]] -= ev["amount"]
            if bal2[ev["from"]] <= 0:
                bal2.pop(ev["from"], None)
        if ev["to"] != ZERO:
            bal2[ev["to"]] += ev["amount"]
    while si2 < len(sample_blocks):
        sample_holder_counts[sample_blocks[si2]] = len(filtered({k: v for k, v in bal2.items() if v > 0}))
        si2 += 1

    # Price samples at each sample block — use closest swap at-or-before that block
    swaps_by_block = sorted(((sw["block"], sw["sqrtPriceX96"]) for sw in swaps), key=lambda x: x[0])
    sample_prices: dict[int, float] = {}
    last_sqrtP = 0
    si3 = 0
    for sb in sample_blocks:
        # Advance through swaps up to sb
        while si3 < len(swaps_by_block) and swaps_by_block[si3][0] <= sb:
            last_sqrtP = swaps_by_block[si3][1]
            si3 += 1
        if last_sqrtP > 0:
            sample_prices[sb] = sqrtPriceX96_to_price(last_sqrtP, target_is_token0, target_dec)

    # 7d trailing volume samples (in ETH)
    swap_buys_by_block = sorted(
        ((sw["block"], amount0_from_swap_to_eth(sw, target_is_token0))
         for sw in swaps
         if amount0_from_swap_to_eth(sw, target_is_token0) > 0
         and target_amount_signed(sw, target_is_token0) < 0),
        key=lambda x: x[0],
    )
    sample_trailing_vol: dict[int, float] = {}
    for sb in sample_blocks:
        lo = sb - 7 * BLOCKS_PER_DAY
        sample_trailing_vol[sb] = sum(v for b, v in swap_buys_by_block if lo <= b <= sb)

    horizons = {
        "30d": (blk_30d, "outcome_30d"),
        "60d": (blk_60d, "outcome_60d"),
        "90d": (blk_90d, "outcome_90d"),
    }
    for name, (blk_h, prefix) in horizons.items():
        if blk_h > head_block:
            continue
        priors = [s for s in sample_blocks if s <= blk_h]
        if not priors:
            continue
        sb_h = priors[-1]

        peak_holder = max((sample_holder_counts.get(s, 0) for s in priors), default=0)
        peak_price = max((sample_prices.get(s, 0.0) for s in priors), default=0.0)
        peak_vol7d = max((sample_trailing_vol.get(s, 0.0) for s in priors), default=0.0)

        cur_holder = sample_holder_counts.get(sb_h, 0)
        cur_price = sample_prices.get(sb_h, 0.0)
        cur_vol7d = sample_trailing_vol.get(sb_h, 0.0)

        # Track-E v3 dispatch Fix 4: retuned thresholds.
        # v2 saw price_floor uniformly True at 0.30 (sqrtPriceX96 was nearly
        # static for dead pools, so the ratio held trivially) and
        # volume_slope uniformly False at peak-relative 0.20 (90d-old tokens
        # have zero weekly volume by then). Raising the price floor to 0.50
        # (half of peak) and switching volume_slope to an absolute floor
        # (≥0.01 ETH/week) gives discriminating labels.
        retention = int(peak_holder > 0 and cur_holder > 0.5 * peak_holder)
        floor = int(peak_price > 0 and cur_price >= 0.50 * peak_price)
        slope = int(cur_vol7d >= 0.01)  # absolute weekly-volume floor in ETH
        composite = int(retention and floor and slope)

        setattr(ext, f"{prefix}_holder_retention", retention)
        setattr(ext, f"{prefix}_price_floor", floor)
        setattr(ext, f"{prefix}_volume_slope", slope)
        setattr(ext, f"{prefix}_composite", composite)

    CACHE_DIR.mkdir(exist_ok=True)
    with open(cache_path, "w") as f:
        json.dump(ext.__dict__, f)
    return ext


# ---------------------------------------------------------------------------
# CSV assembly
# ---------------------------------------------------------------------------

CSV_COLUMNS = [
    "token_address", "ticker", "chain", "platform",
    "launch_ts", "t_window_hours",
    "total_buy_volume_eth", "total_buy_volume_eth_decayed",
    "unique_buyers", "buyer_volumes_eth_json",
    "lp_depth_eth", "lp_removed_24h_eth",
    "early_holders_count", "early_holders_still_holding",
    "hp_delta_recent",
    "holder_count", "holder_balances_json",
    "outcome_30d_holder_retention", "outcome_30d_price_floor",
    "outcome_30d_volume_slope", "outcome_30d_composite",
    "outcome_60d_holder_retention", "outcome_60d_price_floor",
    "outcome_60d_volume_slope", "outcome_60d_composite",
    "outcome_90d_holder_retention", "outcome_90d_price_floor",
    "outcome_90d_volume_slope", "outcome_90d_composite",
    "survived_to_day_7",
    # v4: raw 168h gate components (post-hoc recalibration of survived_to_day_7).
    "holders_at_168h", "lp_depth_168h_eth", "vol_24h_at_168h_eth",
    "hp_trajectory_json",
    "name", "creator_address", "notes",
]


def write_corpus(extractions: list[TokenExtraction], path: Path):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(CSV_COLUMNS)
        for e in extractions:
            row = [getattr(e, c, "") for c in CSV_COLUMNS]
            w.writerow(row)
    print(f"wrote {len(extractions)} rows → {path}")


# ---------------------------------------------------------------------------
# State management
# ---------------------------------------------------------------------------

def load_state() -> dict:
    if STATE_PATH.exists():
        with open(STATE_PATH) as f:
            return json.load(f)
    return {}


def save_state(state: dict):
    STATE_PATH.write_text(json.dumps(state, indent=2))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--pilot", type=int, default=None,
                   help="Run in pilot mode with N tokens.")
    # v3 default window: 90d→8d ago. Earlier 180d→90d window had only flat-
    # tail tokens; the new window captures still-active launches but stops
    # short of the most recent 8d so survived_to_day_7 (t+168h) is always
    # computable. 30/60/90d outcomes will be missing for tokens whose
    # horizons extend past head_block — that's expected and surfaced in the
    # data-quality section.
    p.add_argument("--start-days-ago", type=int, default=90)
    p.add_argument("--end-days-ago", type=int, default=8)
    p.add_argument("--reset", action="store_true")
    p.add_argument("--stratified", action="store_true",
                   help="v4: 50/50 stratified sample. Scans candidates in "
                        "random order and buckets each into survivors "
                        "(≥1 buyer, ≥0.001 ETH) vs dead, stopping when both "
                        "buckets reach --pilot/2 or --max-scan exhausted.")
    p.add_argument("--max-scan", type=int, default=2500,
                   help="Stratified mode: max candidates to extract before "
                        "stopping even if the survivor bucket isn't full.")
    p.add_argument("--snapshot-log", type=str, default=None,
                   help="Path to write per-token, per-snapshot HP component "
                        "JSON lines for diagnostic_hp_delta.py to consume.")
    p.add_argument("--source", choices=["clanker", "liquid", "both"], default="clanker",
                   help="Which launchpad factory to crawl. Default 'clanker' "
                        "preserves v3 behavior (Clanker V4 only). 'liquid' "
                        "crawls Liquid V1 only (used for the v4 validation "
                        "cohort). 'both' merges both factories' discoveries.")
    p.add_argument("--output", type=str, default=None,
                   help="Path to write corpus.csv. Defaults to track-e/corpus.csv "
                        "(overwrites). Use a different path (e.g. v4_corpus.csv) "
                        "to preserve the v3 corpus until the v4 fetch validates.")
    args = p.parse_args()
    output_path = Path(args.output) if args.output else CORPUS_PATH

    # bugbot #66 finding 10: --stratified depends on --pilot to derive
    # target_per_bucket; without --pilot the bucketing branch is dead code
    # and the run silently degrades to non-stratified. Fail loud instead
    # of producing a corpus that misrepresents what the operator asked for.
    if args.stratified and args.pilot is None:
        sys.exit(
            "--stratified requires --pilot N to set the target bucket size "
            "(N/2 each). Re-run with e.g. --pilot 250 --stratified."
        )
    # bugbot #66 finding 12: --pilot 1 --stratified produces target_per_bucket=0
    # via integer division, which makes the bucket-full check always-true and
    # silently drops every extraction. Require pilot ≥ 2.
    if args.stratified and args.pilot < 2:
        sys.exit(
            f"--pilot must be ≥ 2 in stratified mode (got {args.pilot}); "
            "smaller values produce target_per_bucket=0 and an empty corpus."
        )

    if ENV_PATH.exists():
        load_dotenv(ENV_PATH)
    rpc_url = os.environ.get("BASE_MAINNET_RPC_URL", "").strip()
    if not rpc_url or "<" in rpc_url:
        sys.exit(
            "BASE_MAINNET_RPC_URL not set. Add it to track-e/.env (gitignored) "
            "or export it in your shell. See sources.md."
        )

    if args.reset:
        if STATE_PATH.exists():
            STATE_PATH.unlink()
        if CACHE_DIR.exists():
            for p_ in CACHE_DIR.iterdir():
                p_.unlink()

    rpc = RpcClient(url=rpc_url)
    state = load_state()

    chain_id = get_chain_id(rpc)
    if chain_id != CHAIN_ID_BASE:
        sys.exit(f"connected to chain {chain_id}, expected Base ({CHAIN_ID_BASE})")
    head_block = get_block_number(rpc)
    head_ts = get_block_timestamp(rpc, head_block)
    print(f"connected to Base mainnet, head={head_block} ts={head_ts}")

    start_ts = head_ts - args.start_days_ago * 86400
    end_ts = head_ts - args.end_days_ago * 86400
    print(f"target window: {args.start_days_ago}d ago → {args.end_days_ago}d ago")
    print("locating block boundaries…")
    start_anchor = max(0, head_block - args.start_days_ago * BLOCKS_PER_DAY * 2)
    end_anchor = max(0, head_block - args.end_days_ago * BLOCKS_PER_DAY * 2)
    start_block = find_block_at_ts(rpc, start_ts, start_anchor, head_block)
    end_block = find_block_at_ts(rpc, end_ts, max(start_block, end_anchor), head_block)
    print(f"  start_block={start_block}  end_block={end_block}  ({(end_block - start_block) // 1000}k blocks)")

    print(f"\nPhase 1: discovering tokens (source={args.source})…")
    discovered: list[dict] = []
    if args.source in ("clanker", "both"):
        discovered.extend(
            discover_tokens(rpc, from_block=start_block, to_block=end_block, state=state)
        )
    if args.source in ("liquid", "both"):
        discovered.extend(
            discover_liquid_tokens(rpc, from_block=start_block, to_block=end_block, state=state)
        )
    save_state(state)

    # Track-E v4 dispatch Prereq 1: stratified 50/50 sampling. The v3
    # time-stratified random pick gave 97% dead launches because Clanker V4's
    # base mortality is ~95-97%; component analysis on that distribution
    # collapses. v4 explicitly buckets into survivors (≥1 buy + ≥0.001 ETH
    # buy volume) vs dead, sampling --pilot/2 of each. If survivors are
    # scarce we keep scanning up to --max-scan candidates before stopping
    # with whatever ratio is achievable (documented in REPORT v4).
    #
    # The non-stratified path stays for back-compat (e.g. quick small pilots).
    rng = random.Random(42)  # deterministic re-run

    candidates_to_scan = list(discovered)
    # Shuffle whenever we may not process every candidate (pilot is set OR
    # stratified is on). Discovery output is launch_block-sorted, so without
    # this, stratified buckets fill in chronological order — early-window
    # tokens dominate, late-window tokens get dropped (bugbot #66 finding 3:
    # "stratified mode skips shuffle when pilot exceeds discovered" — the
    # bug widens to "any time we cap, we need to randomize first").
    if args.pilot is not None or args.stratified:
        rng.shuffle(candidates_to_scan)
    if args.pilot is not None and args.pilot < len(discovered):
        # Cap depends on mode:
        #  • stratified: scan up to --max-scan candidates and bucket each
        #    into survivors/dead until both buckets fill. Bucket caps mean
        #    we never write more than --pilot tokens to corpus.csv.
        #  • non-stratified: cap directly to --pilot to preserve the v3
        #    "Run in pilot mode with N tokens" semantics (bugbot #66 finding 2).
        cap = args.max_scan if args.stratified else args.pilot
        candidates_to_scan = candidates_to_scan[:cap]

    target_per_bucket = (args.pilot // 2) if args.pilot is not None else None

    # Resolve timestamps only for the tokens we'll actually scan.
    resolve_launch_timestamps(rpc, candidates_to_scan)

    # bugbot #66 finding 1: the platform + factory address must come from
    # the discovery dict, not be hardcoded — Liquid tokens were being
    # mis-tagged as Clanker in --source liquid|both runs.
    factory_by_platform = {
        "clanker": CLANKER_V4_ADDRESS,
        "liquid": LIQUID_V1_ADDRESS,
    }
    with open(DISCOVERED_PATH, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["token_address", "ticker", "platform", "version",
                    "launch_block", "launch_ts", "factory_address"])
        for t in candidates_to_scan:
            ticker = (t.get("name") or "")[:32]
            platform = t.get("platform", "clanker")
            w.writerow([t["token_address"], ticker, platform, t["version"],
                        t["launch_block"], t["launch_ts"],
                        factory_by_platform.get(platform, "")])
    print(f"  wrote {len(candidates_to_scan)} discovered tokens → {DISCOVERED_PATH}")

    if args.stratified and args.pilot is not None:
        print(f"\nPhase 2 (stratified): bucketing into ≤{target_per_bucket} survivors "
              f"+ ≤{target_per_bucket} dead from up to {len(candidates_to_scan)} candidates…")
    else:
        print(f"\nPhase 2: extracting features + outcomes for {len(candidates_to_scan)} tokens…")
    CACHE_DIR.mkdir(exist_ok=True)

    # buffering=1 → line-buffered text mode. Without this, Python uses the
    # default 8KB block buffer, which means diagnostic_hp_delta.py can't read
    # in-progress data during a multi-hour fetch (the survivor lines for the
    # first ~30+ tokens are queued in memory and only land on disk when the
    # fetch ends). Line buffering trades a tiny per-write syscall cost for
    # observable progress.
    # bugbot #66 finding 8: previously a bare open()/close() pair — a
    # KeyboardInterrupt or unhandled exception between them would leak the
    # file handle and lose buffered writes. try/finally guarantees cleanup.
    snapshot_log_fp = (
        open(args.snapshot_log, "w", buffering=1) if args.snapshot_log else None
    )

    survivors: list[TokenExtraction] = []
    dead: list[TokenExtraction] = []
    n_processed = 0
    try:
        for tok in candidates_to_scan:
            n_processed += 1
            symbol = (tok.get("symbol") or "")[:12]
            # Compact progress line — bucket counts let the operator gauge
            # how fast the survivor half is filling.
            prefix = f"  [{n_processed}/{len(candidates_to_scan)} | s:{len(survivors)} d:{len(dead)}]"
            print(f"{prefix} {symbol:<12} {tok['token_address']}…",
                  end="", flush=True)
            t0 = time.monotonic()
            try:
                ext = extract_token_features(rpc, tok, head_block=head_block,
                                             snapshot_log_fp=snapshot_log_fp)
            except Exception as e:
                print(f" FAILED ({e})")
                continue
            if ext is None:
                print(" skipped (non-WETH paired or invalid pool)")
                continue
            dt = time.monotonic() - t0

            is_survivor = (ext.unique_buyers >= 1 and ext.total_buy_volume_eth >= 0.001)
            # bugbot #66 finding 7: tag must distinguish "no buyers + no
            # volume" (truly dead-on-arrival) from "had some activity but
            # below survivor threshold" (e.g. 3 buyers + 0.0008 ETH). The
            # original "zero-activity" label was overloaded — analysts
            # filtering on it would conflate the two regimes. Now we tag
            # the precise reason; analysts who want the broad bucket can
            # still filter on either.
            if ext.unique_buyers == 0 and ext.total_buy_volume_eth == 0.0:
                ext.notes = (ext.notes + ";" if ext.notes else "") + "zero-activity"
            elif not is_survivor:
                ext.notes = (ext.notes + ";" if ext.notes else "") + "below-survivor-threshold"

            if args.stratified and args.pilot is not None:
                bucket = survivors if is_survivor else dead
                if len(bucket) >= target_per_bucket:
                    # Bucket already full — skip and don't write to corpus.
                    print(f" ({dt:.1f}s, bucket full, skipped)")
                    continue
                bucket.append(ext)
                tag = "✓ SURVIVOR" if is_survivor else "dead"
                print(f" {tag} ({dt:.1f}s, {ext.unique_buyers} buyers, "
                      f"{ext.total_buy_volume_eth:.3f} ETH, survived={ext.survived_to_day_7})")
                if len(survivors) >= target_per_bucket and len(dead) >= target_per_bucket:
                    print(f"\nBoth buckets full at {n_processed}/{len(candidates_to_scan)} scanned.")
                    break
            else:
                (survivors if is_survivor else dead).append(ext)
                tag = "✓" if is_survivor else "below-threshold"
                print(f" {tag} ({dt:.1f}s, {ext.unique_buyers} buyers, "
                      f"lp_depth={ext.lp_depth_eth:.3f} ETH, "
                      f"survived={ext.survived_to_day_7})")

        save_state(state)
    finally:
        if snapshot_log_fp:
            snapshot_log_fp.close()

    extractions = survivors + dead
    # bugbot #66 finding 9: prior message claimed "rate among extracted"
    # but computed rate-among-all-scanned (denominator was n_processed,
    # not len(extractions)). The base-rate-in-the-wild is the interesting
    # number; rename the field so the math matches the label. The
    # corpus-internal ratio is by design ~50/50 when stratified.
    base_rate = 100 * len(survivors) / max(n_processed, 1) if n_processed else 0.0
    corpus_ratio = (
        100 * len(survivors) / max(len(extractions), 1) if extractions else 0.0
    )
    print(f"\nPhase 3: writing corpus.csv "
          f"({len(extractions)} tokens; {len(survivors)} survivors + {len(dead)} dead; "
          f"corpus survivor share: {corpus_ratio:.1f}%; "
          f"base survivor rate in scan: {base_rate:.1f}% of {n_processed} scanned)")
    write_corpus(extractions, output_path)


if __name__ == "__main__":
    main()
