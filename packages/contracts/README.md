# @filter-fun/contracts

Smart-contract suite for filter.fun on Base. Foundry / Solidity 0.8.26 / Uniswap V4.

## Overview

Core contracts:

| Contract             | Role                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `FilterLauncher`     | Top-level. Owns season state, phase machine, per-wallet launch caps. Launches $FILTER.            |
| `FilterFactory`      | Single-tx deploy: ERC-20 → V4 pool init → seed full-range LP → per-token `FilterLpLocker`.        |
| `FilterHook`         | V4 hook gating add/remove-liquidity to the factory (initial seed) and locker (post-seed).          |
| `FilterLpLocker`     | Per-token. Holds the V4 LP. Splits collected fees per BPS, exposes settlement primitives.          |
| `SeasonVault`        | Per-season escrow. Multi-filter event accounting, allocates pot, serves rollover Merkle claim.    |
| `SeasonPOLReserve`   | Per-season WETH-only POL holder. Accumulates the 10% slice across filter events.                  |
| `POLVault`           | Singleton. Receives winner-token POL exposure across all seasons.                                 |
| `BonusDistributor`   | 14-day hold-bonus payout via multi-snapshot Merkle roots posted by the oracle.                     |
| `TreasuryTimelock`   | OZ `TimelockController` on the 10% treasury cut. 48h delay.                                       |

Plus `FilterToken` (the ERC-20 deployed for every launch).

## User-aligned settlement model

There are multiple **filter events** during the week — at each cut, a set of tokens is liquidated and the proceeds are split immediately:

```
45% rollover  → accumulate as WETH (buy winner tokens at final settlement, distribute via Merkle)
25% bonus     → accumulate as WETH (forward to BonusDistributor at final settlement)
10% mechanics → WETH to events/missions wallet (immediate, every event)
10% POL       → accumulate as WETH in SeasonPOLReserve (deploy at final settlement only)
10% treasury  → WETH to TreasuryTimelock (immediate, every event)
────────────────
100%
```

80% of every losers-pot dollar is user-aligned (rollover + bonus + mechanics).

**POL is silent during the week.** It accumulates as WETH in `SeasonPOLReserve` and is *only* deployed once the final winner is known — preventing the protocol from biasing the live competition. At final settlement the reserve is drained, used to buy winner tokens, and the result is parked in the singleton `POLVault`.

Trading-fee streams (FilterLpLocker → vault) accrue separately and are not subject to the losers-pot BPS — the vault measures the WETH delta produced by liquidations and only that delta is split. Trading-fee residue is swept to treasury at `submitWinner` time.

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

### Base Sepolia (Epic 1.6)

One command, idempotent, writes a manifest the indexer + web read for addresses:

```sh
cp .env.sepolia.example .env.sepolia    # fill DEPLOYER_PRIVATE_KEY, TREASURY_OWNER, etc.
npm run deploy:sepolia                  # mine salt → deploy → verify on Basescan
npm run deploy:sepolia:seed             # also runs SeedFilter.s.sol (after oracle startSeason)
```

The script:

1. Mines the FilterHook CREATE2 salt inline (cached in the manifest after the first run).
2. Deploys the suite in dependency order: TreasuryTimelock → BonusDistributor → POLVault →
   FilterLauncher (inline-deploys CreatorRegistry / CreatorFeeDistributor /
   TournamentRegistry / TournamentVault) → POLManager → FilterHook → FilterFactory.
3. Wires `polManager` ↔ `launcher` ↔ `polVault`, `factory` ↔ `hook` ↔ `launcher`.
4. Applies Sepolia config: `setMaxLaunchesPerWallet` and `setRefundableStakeEnabled`.
5. Writes `deployments/base-sepolia.json` with addresses, block height, deploy commit
   hash, and the cached hook salt.
6. Verifies each contract on Basescan via `forge verify-contract`.

End-to-end smoke-test runbook: [`docs/runbook-sepolia-smoke.md`](../../docs/runbook-sepolia-smoke.md).
Operator-runbook §8 covers the full happy-path lifecycle plus the rotation step below.

The script refuses to overwrite an existing manifest. To redeploy, `rm
deployments/base-sepolia.json` (or pass `--force-redeploy` / `FORCE_REDEPLOY=1`).

### Operational scripts

Three companion scripts live alongside `DeploySepolia` and follow the same env-driven
pattern (`MANIFEST_PATH_OVERRIDE`, `DEPLOYER_PRIVATE_KEY`, etc.):

- **`SeedFilter.s.sol`** — populates `$FILTER` after the oracle calls `startSeason()`.
  Refuses to double-seed by probing `manifest.filterToken.address`.
- **`VerifySepolia.s.sol`** — read-only operational verifier. Asserts five invariants
  against the live deploy: `maxLaunchesPerWallet == 1` (spec §4.6 lock),
  `$FILTER` registered in `CreatorRegistry`, `tournamentRegistry.launcher == FilterLauncher`,
  `launcher.polManager` and `launcher.treasury` match the manifest, and `adminOf == creatorOf`
  for every token in the current season. Emits `VerifySepoliaOK` on success or reverts
  with `AssertionFailed_<n>`. Use `SKIP_FILTER_TOKEN_CHECK=1` for pre-seed verifications.
- **`RedeployFactory.s.sol`** — operator-facing factory rotation. Required after PR #43
  on Sepolia (factory needs `CreatorCommitments` in its constructor). Mines a fresh
  `HOOK_SALT` strictly above the cached one so the new `FilterHook` lands at an unoccupied
  CREATE2 address, archives the prior manifest under `deployments/archive/<basename>-<unix-ts>.json`,
  then delegates to `DeploySepolia` with `FORCE_REDEPLOY=1`. Refuses to run if the current
  season has any public launches unless `ACTIVE_LAUNCH_OK=1`. Emits `FactoryRedeployed`
  with the old/new factory + launcher pair and the archive path.

```sh
# Verify the live deploy matches spec (skips $FILTER check if pre-seed):
SKIP_FILTER_TOKEN_CHECK=1 forge script script/VerifySepolia.s.sol \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"

# Rotate the factory (refuses unless either no active launches or ACTIVE_LAUNCH_OK=1):
forge script script/RedeployFactory.s.sol \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
```

### Test harness notes

The Foundry test harness uses `--isolate --threads 1` (wired via `package.json`'s `test`
script and the `contracts-ci.yml` workflow). The matching `isolate = true` and `threads = 1`
fields in `foundry.toml` are aspirational — `forge test` in stable 1.5.1 silently ignores
them, so the CLI flags are the actual enforcement. Without these flags `Deploy.t.sol`
flakes on cross-test CREATE2 collisions and shared `vm.setEnv` / `vm.writeJson` state.

### Mainnet (legacy DeployGenesis)

The original mainnet deploy uses `DeployGenesis.s.sol` with multisig roles:

```sh
forge script script/MineHookSalt.s.sol -vv
export HOOK_SALT=0x...
forge script script/DeployGenesis.s.sol --rpc-url $BASE_RPC_URL --broadcast --verify
forge script script/LaunchFilterToken.s.sol --rpc-url $BASE_RPC_URL --broadcast
```

### Hook salt — why it must be mined

V4 routes hook calls based on the lower 14 bits of the hook address. `FilterHook` requires `BEFORE_ADD_LIQUIDITY` (1<<11) | `BEFORE_REMOVE_LIQUIDITY` (1<<9) = `0xA00`. `MineHookSalt` (and `DeploySepolia.s.sol` inline) brute-forces the CREATE2 salt that lands the hook at a matching address. Under `vm.broadcast`, Foundry routes `new Contract{salt: ...}()` through the Deterministic Deployer Proxy at `0x4e59b44847b379578588920cA78FbF26c0B4956C`, so the salt is mined against that — not the operator's EOA — and is therefore identical across machines.
