# filter.fun 🔻

A competitive, weekly token-launcher game on Base. Tokens are created, traded, filtered, and consolidated into a single weekly winner. Capital from losing tokens is not destroyed — it is filtered and redirected into the winner, with users retaining exposure via automatic rollover and a hold bonus.

> Launch. Get filtered. Survive.

## Status

**Genesis iteration.** The smart-contract suite (Foundry) and monorepo skeleton ship in this branch. Indexer, scoring engine, scheduler, oracle service, and web app are scaffolded as empty workspace packages and will follow.

## Layout

```
packages/
├── contracts/   ★ Foundry contract suite (this iteration)
├── indexer/     stub
├── scoring/     stub
├── scheduler/   stub
├── oracle/      stub (multisig-signed settlement payload service)
└── web/         stub (Next.js app)
```

## Working with contracts

```sh
cd packages/contracts
forge build
forge test
```

Or from the repo root:

```sh
npm install
npm run build:contracts
npm run test:contracts
```

## Architecture

Five contracts. See `packages/contracts/README.md` for details and the original product spec.

| Contract            | Role                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- |
| `FilterLauncher`    | Wraps clanker. Owns season phase state and per-wallet launch caps. Launches $FILTER. |
| `SeasonVault`       | Per-season escrow. Liquidates losers, holds settlement Merkle root, processes rollover claims. |
| `FeeSplitter`       | Per-token CREATE2 contract. Clanker's `feeRecipient`. Splits LP fees into season pot / treasury / mechanics. |
| `BonusDistributor`  | 14-day hold bonus via multi-snapshot Merkle roots.                                 |
| `TreasuryTimelock`  | OZ `TimelockController` on the 20% treasury cut.                                   |

## $FILTER

Week 1's protocol-launched seed token. Deployed via `script/LaunchFilterToken.s.sol`. Plays the game like any other token — can win or lose.
