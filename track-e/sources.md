# Track E — Data Sources

Authoritative reference for every factory contract, event signature, and pool
dependency the corpus fetcher (`fetch_corpus.py`) reads. Every entry links to
Basescan so a third party can independently regenerate the corpus.

Last verified: 2026-05-01.

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

## Bankr — Base mainnet

**Status: factory address not located as of 2026-05-01.**

Bankr token launches happen via the bankr.bot AI agent, but the deployed
factory contract address is not published in their docs
([docs.bankr.bot](https://docs.bankr.bot/)) or the
[github.com/bankrbot](https://github.com/bankrbot) org. BankrCoin (BNKR)
itself lives at
[0x22af33fe…6f3b](https://basescan.org/token/0x22af33fe49fd1fa80c7149773dde5890d3c76f3b)
but that's the BNKR token, not the factory.

**Action:** Skipped from v1 corpus. Follow-up: reach out to Bankr team or scrape
recent token-creation transactions from their backend to identify the factory.

## Liquid — Base mainnet

**Status: ambiguous identification.**

- [LiquidLaunch (liquidlaunch.app)](https://liquidlaunch.app/) is on
  Hyperliquid EVM, not Base — out of scope.
- Uniswap's "Liquidity Launchpad" / CCA factory is referenced for Base in
  [docs.uniswap.org/contracts/liquidity-launchpad](https://docs.uniswap.org/contracts/liquidity-launchpad/Overview)
  but the Deployments page errors and the
  [Uniswap/liquidity-launcher](https://github.com/Uniswap/liquidity-launcher)
  GitHub repo doesn't list a Base mainnet address. The system is single-address
  CREATE2-deterministic across chains but the address isn't surfaced on the
  doc page that loaded successfully.

The "Liquid-style" architecture reference in filter.fun's spec (per
ROADMAP.md) means *own factory + hook + LP-locker, not a Clanker wrap* — so
"Liquid" in the Track E corpus prompt is treated as a comparable launchpad,
not filter.fun's own design pattern.

**Action:** Skipped from v1 corpus. Follow-up: clarify which "Liquid" the
spec means and locate its Base factory address.

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
