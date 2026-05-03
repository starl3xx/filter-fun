# Track E — Data Sources

Authoritative reference for every factory contract, event signature, and pool
dependency the corpus fetcher (`fetch_corpus.py`) reads. Every entry links to
Basescan so a third party can independently regenerate the corpus.

Last verified: 2026-05-02 (v3).

## Clanker (multi-version) — Base mainnet

Clanker has shipped several factory iterations on Base since late 2024. Each
emits a `TokenCreated` event whose ABI evolved across versions. The fetcher
crawls all known deployers to maximize sample size.

Version labels here follow [Bitquery's Clanker indexing
docs](https://docs.indexing.co/examples/clanker_deployments) (chronological:
V1 = oldest deployer). The Basescan-shown internal version label is noted in
parentheses where it differs.

| Label | Factory address | Pairs into | Key event params |
|---|---|---|---|
| V1 | [0x250c9FB2…6AeA47](https://basescan.org/address/0x250c9FB2b411B48273f69879007803790A6AeA47) | Uniswap V3 | tokenAddress, lpNftId, deployer, name, symbol, supply, _supply, lockerAddress |
| V2 | [0x9B84fcE5…7c3e1](https://basescan.org/address/0x9B84fcE5Dcd9a38d2D01d5D72373F6b6b067c3e1) | Uniswap V3 | + fid, castHash (Farcaster integration) |
| V3 | [0x732560fa…3833](https://basescan.org/address/0x732560fa1d1A76350b1A500155BA978031B53833) | Uniswap V3 | tokenAddress, positionId, deployer, fid, name, symbol, supply, lockerAddress, castHash |
| V3.1 (Basescan: "Clanker v3.0.0") | [0x375C15db…2c5E](https://basescan.org/address/0x375C15db32D28cEcdcAB5C03Ab889bf15cbD2c5E) | Uniswap V3 | indexed tokenAddress, positionId, indexed deployer, fid, name, symbol, supply, castHash |
| V3.5 (Basescan: "Clanker v3.1") | [0x2A787b23…7382](https://basescan.org/address/0x2A787b2362021cC3eEa3C24C4748a6cD5B687382) | Uniswap V3 | indexed tokenAddress, indexed creatorAdmin, indexed interfaceAdmin, …, positionId, name, symbol, startingTickIfToken0IsNewToken, metadata, amountTokensBought, vaultDuration, vaultPercentage, msgSender |
| V4 | [0xE85A59c6…83a9](https://basescan.org/address/0xE85A59c628F7d27878ACeB4bf3b35733630083a9) | Uniswap V4 | indexed msgSender, indexed tokenAddress, indexed tokenAdmin, tokenMetadata, tokenImage, tokenName, tokenSymbol, tokenContext, poolHook, poolId, startingTick, pairedToken, locker, mevModule, extensionsSupply, extensions[] |

Full ABI signatures are in `fetch_corpus.py::CLANKER_VERSIONS`.

**Version activity in the v3 corpus window (2026-02-01 → 2026-04-30, verified
2026-05-02):** V1, V2, V3, V3.1, V3.5 all emit **zero** events from their
factories in the 3-month window. V4 emits 41,211 `TokenCreated` events. The
v3 corpus is therefore Clanker-V4-only — version-stratified sampling is
moot — and we time-stratify within V4 instead (3 equal time bins across the
window, sampled in proportion to launch density per bin, deterministic
seed=42).

## Bankr — Base mainnet

**Status (v3, 2026-05-02): Bankr is a Clanker frontend, not a separate
factory.** Bankr launches go through the Clanker factory; tokens already
appear in the V4 corpus. Per-token attribution to Bankr requires either:

1. The `castHash` field in V2/V3/V3.1 `TokenCreated` events (Farcaster-cast
   provenance). Not applicable for v3 because V2/V3/V3.1 are dormant.
2. Inspecting V4's `tokenContext` (string, often JSON) for cast/farcaster
   hints. Format isn't documented; reverse-engineering it across sample
   events is feasible but heuristic.
3. Cross-referencing deployer wallets against a known-Bankr deployer list
   sourced from public Bankr posts.

**Action for v3:** Bankr attribution is **deferred** — the v3 corpus is
treated as Clanker-V4 in aggregate (with the implicit understanding that
some fraction is Bankr-originated). Follow-up: reverse-engineer V4
`tokenContext` JSON format and add a `bankr_attributed: bool` column.

## Liquid — Base mainnet

**Status (v4, 2026-05-02): factory verified at
[`0x04F1…7760`](https://basescan.org/address/0x04F1a284168743759BE6554f607a10CEBdB77760)**
(Liquid Protocol's published address per
[app.liquidprotocol.org/docs](https://app.liquidprotocol.org/docs)). Contract
bytecode 12,481 bytes; deployed at block 43,323,646 (2026-03-13); 2,613
lifetime `TokenCreated` events as of 2026-05-02 head (block 45,489,609).

| Component | Address |
|---|---|
| Liquid factory | [`0x04F1a284168743759BE6554f607a10CEBdB77760`](https://basescan.org/address/0x04F1a284168743759BE6554f607a10CEBdB77760) |
| LiquidFeeLocker | [`0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF`](https://basescan.org/address/0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF) |
| LiquidLpLockerFeeConversion | [`0x77247fCD1d5e34A3703AcA898A591Dc7422435f3`](https://basescan.org/address/0x77247fCD1d5e34A3703AcA898A591Dc7422435f3) |
| LiquidPoolExtensionAllowlist | [`0xb614167d79aDBaA9BA35d05fE1d5542d7316Ccaa`](https://basescan.org/address/0xb614167d79aDBaA9BA35d05fE1d5542d7316Ccaa) |
| LiquidHookDynamicFeeV2 | [`0x80E2F7dC8C2C880BbC4BDF80A5Fb0eB8B1DB68CC`](https://basescan.org/address/0x80E2F7dC8C2C880BbC4BDF80A5Fb0eB8B1DB68CC) |
| LiquidHookStaticFeeV2 | [`0x9811f10Cd549c754Fa9E5785989c422A762c28cc`](https://basescan.org/address/0x9811f10Cd549c754Fa9E5785989c422A762c28cc) |

Event signature (verified against Sourcify partial-match for
`Liquid.sol::ILiquid`; `keccak(sig) == 0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67`,
which matches the dominant log topic on the factory):

```solidity
event TokenCreated(
    address          msgSender,
    address indexed  tokenAddress,
    address indexed  tokenAdmin,
    string           tokenImage,
    string           tokenName,
    string           tokenSymbol,
    string           tokenMetadata,
    string           tokenContext,
    int24            startingTick,
    address          poolHook,
    PoolId           poolId,            // bytes32
    address          pairedToken,
    address          locker,
    address          mevModule,
    uint256          extensionsSupply,
    address[]        extensions
);
```

Pairs into Uniswap V4 (same PoolManager
[`0x498581ff…2b2b`](https://basescan.org/address/0x498581fF718922c3f8e6A244956aF099B2652b2b)
as Clanker V4), so swap / ModifyLiquidity / Transfer ingestion in
`extract_token_features` is launchpad-agnostic from the discovery step
onward — only `discover_liquid()` and the locker/hook exclusion list need
to be Liquid-specific.

**Action for v4:** Liquid is in scope for the validation cohort (top-25 by
FDV). Wired in `fetch_corpus.py::LIQUID_VERSIONS` (see ticket #31). Lockers
above are added to `KNOWN_NON_HOLDER_ADDRESSES` so HHI excludes locked-LP
balances per spec §41.3.

Two earlier candidate addresses (ruled out as EOAs with zero log activity)
are kept here for historical context to prevent re-verification:
[`0xCb22…0f85`](https://basescan.org/address/0xcb22ed2b12da1365539283e2891bb93ba10a0f85),
[`0xab37…64fe`](https://basescan.org/address/0xab3754736c1a426461259764ed28115d01bb64fe).

## Filterfun (own project)

**Skipped.** Sepolia testnet only at this point; insufficient mainnet history
for the 6-mo to 90d corpus window. Add to v2 once mainnet has 90+ days of
production data.

## Pool / DEX dependencies

The fetcher resolves a token's pool by:
1. **Uniswap V3 (Clanker V1–V3.5):** call `factory.getPool(token, WETH, fee)` for
   each of `[100, 500, 3000, 10000]` fee tiers; pick the pool with positive
   liquidity at the launch+96h block. Factory:
   [0x33128a8f…FDfD](https://basescan.org/address/0x33128a8fC17869897dcE68Ed026d694621f6FDfD).
2. **Uniswap V4 (Clanker V4):** decode `poolId` directly from the
   `TokenCreated` event; resolve via PoolManager
   [0x498581fF…Bf7](https://basescan.org/address/0x498581fF718922c3f8e6A244956aF099B2652b2b)
   (verify before crawl). Pool state read via the v4 StateView lens contract.

WETH on Base: [0x4200…0006](https://basescan.org/address/0x4200000000000000000000000000000000000006).

Token decimals are read on demand from each token contract via
`decimals()` (selector `0x313ce567`). All ETH-side volumes in the CSV are
normalized to ETH (1e18 scale, not raw wei or token units).

## Address exclusions for HHI computation (per spec §41.3)

Addresses excluded from `holder_count` and `holder_balances_json` (codified in
`fetch_corpus.py::KNOWN_NON_HOLDER_ADDRESSES`):

- `0x0000000000000000000000000000000000000000` — null address
- `0x000000000000000000000000000000000000dEaD` — burn address
- `0x4200000000000000000000000000000000000006` — WETH
- Per-launchpad locker contracts (Clanker per-version locker addresses, read
  from the `lockerAddress` field of each TokenCreated event)
- Uniswap V3 NonfungiblePositionManager
  [0x03a520b3…BA1](https://basescan.org/address/0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1)
- Uniswap V4 PoolManager (above)
- 0x router
  [0xDef1C0de…51](https://basescan.org/address/0xDef1C0ded9bec7F1a1670819833240f027b25EfF)
- Heuristic: any wallet that holds ≥ 50 distinct corpus tokens simultaneously
  is flagged as a contract/aggregator and excluded.

## LP-burn indexing (v3)

`lp_removed_24h_eth` is the spec rug-indicator: WETH-side volume of LP burns
in the **first 24h after launch**. v3 sources it from V4 `ModifyLiquidity`
events with `liquidityDelta < 0`, mapped to WETH via `v4_full_range_weth_wei()`
using the nearest-block `sqrtPriceX96`. The full launch→t+168h window is
indexed once and `burn_events` is keyed by block so any snapshot can read
"removed in 24h prior to <block>" in O(1) without re-fetching logs. (v2
incorrectly used the [t+72h, t+96h] window, which gave 0% non-zero across
the corpus because V4 lockers hold the position past the first day.)

## Validation cohort selection (v5 — liquidity-first scan)

The v4 validation cohort (`validation_cohort.py`) used random-sample-then-FDV-filter
and returned n=7 because only ~0.14% of a 5,120-token random subsample had any
recent swap activity (the active-token base rate on Clanker V4 is much lower than
the survival-half base rate). The v5 cohort (`validation_cohort_v5.py`) inverts
the funnel:

1. Discover all Clanker V4 + Liquid V1 candidates over the 180d→30d-ago window
   (same window as the main corpus — these are the cross-reference universe).
2. Scan the Uniswap V4 PoolManager (`0x498581ff…`) for `Swap` events over the
   last 7d. Decode `topic[1]` as `pool_id` and the data payload for amount0/amount1.
3. Filter swaps by pool_id ∈ candidate index. Group by pool_id, rank by swap count
   (primary) and accumulated `|amount0| + |amount1|` (tie-breaker).
4. FDV-sample the top-N most-active pools (default top-500 of typically ~1,000
   active matches). FDV uses the same decimals-correct path as PR #76.
5. Take top-N per platform by FDV → cohort. Resolve timestamps + extract features
   via the same path as `fetch_corpus.py`. FDV is stashed in `notes` so
   `validate_hp_rank.py` reads it unchanged.

Estimated cost: ~15-30 min total (vs PR #76's 40 min for a smaller cohort).
Bandwidth-heavy step is the unfiltered PoolManager Swap scan (~2.5M logs over 7d
on Base). The `get_logs` helper auto-chunks on `log_limit` errors.

## Outcome label sampling

`outcome_{30d,60d,90d}_*` labels are computed by sparse weekly sampling of pool
state (price via `slot0`/`getReserves`) and holder count (via cumulative
Transfer event replay). "Peak" metrics are the max of these weekly samples.
This loses a small amount of precision vs. block-by-block tracking but cuts
RPC cost ~700×; the analysis pipeline is robust to ±5% noise on outcome
labels per the synthetic-data sensitivity tests in
`SYNTHETIC_DEMO_REPORT.md`.

## Reproducibility

To regenerate the corpus from scratch:

```sh
# 1. Set your Alchemy Base mainnet endpoint (never commit this file)
echo 'BASE_MAINNET_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<your-key>' \
    > track-e/.env

# 2. Install deps via uv (pyproject.toml in track-e/)
cd track-e && uv sync

# 3. Pilot run (50 tokens, ~5–10 minutes, ~5–10M Alchemy CUs)
uv run python3 fetch_corpus.py --pilot 50

# 4. Validate against pipeline.py
uv run python3 pipeline.py --input corpus.csv --output REPORT.md

# 5. Full run (target 500–2000 tokens, ~hours, ~hundreds of millions of CUs)
uv run python3 fetch_corpus.py
```

The fetcher is checkpointed at `track-e/.fetch_state.json` — interruptions
resume cleanly without re-crawling completed work.
