# @filter-fun/indexer

Ponder-based on-chain event indexer for filter.fun. Consumes `FilterLauncher`, `SeasonVault`, `FilterLpLocker`, and `BonusDistributor` events into a Postgres-backed query layer.

## Layout

- `ponder.config.ts` — networks, contracts, factory patterns. Reads addresses from env.
- `ponder.schema.ts` — `season`, `token`, `feeAccrual`, `phaseChange`, `liquidation`, `rolloverClaim`, `bonusFunding`, `bonusClaim`.
- `src/*.ts` — event handlers grouped by source contract.
- `abis/*.json` — Foundry-extracted ABIs. Run `npm run abi:sync` after any contract change.

## Setup

```sh
npm install
cp .env.example .env  # fill in RPC + addresses post-deploy
npm run abi:sync
npm run codegen       # validates types against ABIs + schema
npm run dev           # local dev, requires deployed contracts + RPC
```

## Status (genesis-of-indexer)

- Schema + handlers cover every event the contracts emit.
- Factory pattern is wired: `SeasonVault` instances tracked via `FilterLauncher.SeasonStarted`; `FilterLpLocker` instances tracked via `FilterFactory.TokenDeployed`.
- Addresses are placeholders — real wiring happens at testnet deploy.

## Outstanding

- `FilterFactory.TokenDeployed` adds the locker but doesn't index `FilterFactory` directly. If we want pool keys / start blocks per launch in the index, add a small handler.
- No tests yet. Ponder ships with a `ponder test` mode; we'll wire that up alongside the testnet deploy when we have real fixture data.
- `npm install` not yet run in CI — Ponder API correctness will be validated at first install + codegen.
