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
35% rollover  → buy winner tokens, distribute via Merkle
15% bonus     → BonusDistributor reserve (14-day hold bonus)
20% POL       → buy winner tokens, retain in protocol-owned wallet
20% treasury  → USDC to TreasuryTimelock
10% mechanics → USDC to events/missions wallet
────────────────
100%
```

## Trust model

- Oracle (2-of-3 multisig) submits per-season settlement payloads: winner, losers, per-loser USDC `minOut` floors, rollover Merkle root.
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

23 tests pass on the genesis branch — `SeasonVault.t.sol`, `BonusDistributor.t.sol`, `FilterLauncher.t.sol`, and `integration/WeeklyLifecycle.t.sol` (full $FILTER launch → trade → filter → settle → claim → bonus).

V4 integration tests (`FilterFactory` + `FilterLpLocker` + `FilterHook` against a live `PoolManager`) ship in the next iteration once the deploy + testnet bring-up lands.

## Deploy

```sh
forge script script/DeployGenesis.s.sol --rpc-url $BASE_RPC_URL --broadcast --verify
forge script script/LaunchFilterToken.s.sol --rpc-url $BASE_RPC_URL --broadcast
```

`DeployGenesis` requires a pre-mined `HOOK_SALT` — `FilterHook`'s deployment address must encode the `BEFORE_ADD_LIQUIDITY` and `BEFORE_REMOVE_LIQUIDITY` flag bits (lower-14-bit pattern `0xA00`). A `MineHookSalt` script ships next iteration.
