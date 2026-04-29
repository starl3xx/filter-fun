# @filter-fun/contracts

Smart-contract suite for filter.fun on Base. Foundry / Solidity 0.8.26 / Uniswap V4.

## Overview

Five core contracts:

| Contract             | Role                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `FilterLauncher`     | Top-level. Owns season state, phase machine, per-wallet launch caps. Launches $FILTER.            |
| `FilterFactory`      | Single-tx deploy: ERC-20 → V4 pool init → seed full-range LP → per-token `FilterLpLocker`.        |
| `FilterHook`         | V4 hook gating add/remove-liquidity to the factory (initial seed) and locker (post-seed).          |
| `FilterLpLocker`     | Per-token. Holds the V4 LP. Splits collected fees per BPS, exposes settlement primitives.          |
| `SeasonVault`        | Per-season escrow. Settlement state machine, allocates pot, serves rollover Merkle claim.          |
| `BonusDistributor`   | 14-day hold-bonus payout via multi-snapshot Merkle roots posted by the oracle.                     |
| `TreasuryTimelock`   | OZ `TimelockController` on the 20% treasury cut. 48h delay.                                        |

Plus `FilterToken` (the ERC-20 deployed for every launch).

## Allocation policy at settlement

```
35% rollover  → buy winner tokens, distribute via Merkle (share-based)
15% bonus     → BonusDistributor WETH reserve (14-day hold bonus)
20% POL       → buy winner tokens, retain in protocol-owned wallet
20% treasury  → WETH to TreasuryTimelock
10% mechanics → WETH to events/missions wallet
────────────────
100%
```

All settlement-side accounting is WETH: tokens are paired against WETH at launch, and liquidations recover WETH from the pool. Stable-denomination accounting (e.g. USDC) was considered and rejected — it would force a swap leg per liquidation.

## Trust model

- Oracle (2-of-3 multisig) submits per-season settlement payloads: winner, losers, per-loser WETH `minOut` floors, rollover Merkle root.
- 24h timelock on settlement payloads (out of contract scope; enforced via `liquidationDeadline`).
- Off-chain scoring algorithm + inputs published before each season opens. Trust comes from reproducibility, not on-chain verification.
- Memecoin game, not Curve. Don't overengineer.

## Install & build

`lib/` is gitignored — install dependencies on first clone:

```sh
cd packages/contracts
forge install --no-git foundry-rs/forge-std
forge install --no-git OpenZeppelin/openzeppelin-contracts@v5.5.0
forge install --no-git Vectorized/solady
forge install --no-git Uniswap/v4-core
forge install --no-git Uniswap/v4-periphery
```

Then:

```sh
forge build
forge test
forge test --gas-report
```

31 tests pass on the genesis branch:

- Unit: `SeasonVault.t.sol`, `BonusDistributor.t.sol`, `FilterLauncher.t.sol`.
- Integration: `WeeklyLifecycle.t.sol` (mock-based full lifecycle), `V4Lifecycle.t.sol` (factory + locker + hook against a live `PoolManager`), `V4Settlement.t.sol` (single-loser settlement on V4), `V4MultiLoserSettlement.t.sol` (multi-loser + multi-leaf Merkle claims, sequential liquidations, idempotency guard).

## Deploy

```sh
forge script script/DeployGenesis.s.sol --rpc-url $BASE_RPC_URL --broadcast --verify
forge script script/LaunchFilterToken.s.sol --rpc-url $BASE_RPC_URL --broadcast
```

`DeployGenesis` reads a pre-mined `HOOK_SALT` from the environment — the `FilterHook` address must encode the `BEFORE_ADD_LIQUIDITY` (1<<11) and `BEFORE_REMOVE_LIQUIDITY` (1<<9) flag bits (combined: lower-14-bit pattern `0xA00`). Use the `HookMiner` library (shared with the test suite) to compute the salt offline, then pass it via `HOOK_SALT`. A `MineHookSalt.s.sol` convenience wrapper ships in a follow-up.
