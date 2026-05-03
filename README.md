# filter.fun ▼

> Get filtered or get funded ▼

> One of the problems with most token launchpads is that the vast majority of tokens launched die or never take off at all. With filter.fun, that's a feature, not a bug. **We've solved launchpads.**

- **Product docs:** https://docs.filter.fun — canonical 5-step explainer, HP scoring, risk disclosure, season cadence, API reference. The spec and roadmap excerpts live there too.
- **Operator runbooks:** [`docs/runbook-operator.md`](docs/runbook-operator.md) · [`docs/runbook-sepolia-smoke.md`](docs/runbook-sepolia-smoke.md) · [`docs/zombie-tokens.md`](docs/zombie-tokens.md) · [`docs/bag-lock.md`](docs/bag-lock.md)

This README is a developer entry point. It does not retell the product. Read the docs site for that.

## Status

**Phase 1 in flight — Base Sepolia testnet live, mainnet pending audit.**

Capped launches, tournament series contracts, indexer HTTP API, Arena leaderboard, ticker, launch page, creator admin console, and creator bag-lock contracts have all merged. Filter-moment overlay (Epic 1.9) and the bag-lock web surface (Epic 1.13 web) are the remaining Phase 1 items.

## Architecture

A 6-package npm workspace plus a small `cadence` library that the scheduler and indexer share for hour anchors.

| Package     | Stack                              | Role                                                                                              |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `contracts` | Foundry · Solidity 0.8.26          | Uniswap V4 hook-native launcher, factory, locker, season vault, POL, bonus, tournament registry. |
| `oracle`    | TypeScript                         | Merkle + pro-rata payload builders for filter events, settlement, and the 14-day bonus.          |
| `scheduler` | viem                               | On-chain driver — phase, settlement, and bonus arcs against the deployed contracts.              |
| `indexer`   | Ponder + HTTP API                  | `/season` · `/tokens` · `/events` (SSE) · `/profile`, with caching + per-IP rate limit.          |
| `scoring`   | TypeScript                         | HP engine — velocity, effective buyers, sticky liquidity, retention, momentum.                    |
| `web`       | Next.js 14 + wagmi v2              | Arena, `/launch`, `/token/[address]/admin`, claim flows. Brand kit ▼ glyph throughout.            |

V4 hook gating restricts add/remove-liquidity to the factory (seed) and locker (post-seed); swaps stay open so filtered tokens remain tradable forever (the "zombie" surface is intentional). All settlement-side accounting is WETH.

## Build & dev

```sh
npm install                                   # workspace install
npm run build:contracts                       # forge build
npm run test:contracts                        # forge test
npm --workspace @filter-fun/oracle    test
npm --workspace @filter-fun/scheduler test
npm --workspace @filter-fun/scoring   test
npm --workspace @filter-fun/indexer   test
npm --workspace @filter-fun/web       test
npm --workspace @filter-fun/web       build   # Next.js production build
```

CI runs the same commands per-package: `.github/workflows/contracts-ci.yml` (Foundry build + tests + `forge fmt --check`) and `.github/workflows/off-chain-ci.yml` (typecheck + tests for oracle / scheduler / scoring / web + `ponder codegen` for indexer).

## Deploying

- **Base Sepolia:** [`docs/runbook-sepolia-smoke.md`](docs/runbook-sepolia-smoke.md) — `npm run deploy:sepolia` chains mine → deploy → verify; `script/SeedFilter.s.sol` seeds $FILTER. Manifest written to `packages/contracts/deployments/base-sepolia.json` and consumed by indexer + web. Sepolia was **redeployed 2026-05-01** with the Epic 1.13 contracts (FilterFactory v2 + CreatorCommitments + CreatorRegistry) — bag-lock features only enforce on tokens deployed by this factory; pre-1.13 legacy tokens cannot be bag-locked even if the call appears to succeed (see [`docs/bag-lock.md`](docs/bag-lock.md) §5).
- **Season ops:** [`docs/runbook-operator.md`](docs/runbook-operator.md) — full season-by-season SOP including bag-lock procedure (§5.6).
- **Mainnet:** blocked on Phase 2 audit (Epic 2.3).

## Contributing

Issues + PRs welcome. Open early against `main`; bugbot reviews each PR and we iterate from there. Phase / epic / task structure lives in the project roadmap (referenced from the docs site).

## Credits

Uniswap V4 (hook + pool manager), OpenZeppelin v5 (`TimelockController`, ERC-20 plumbing), Foundry, Ponder, viem, wagmi, Next.js, Bricolage Grotesque + JetBrains Mono.

filter.fun · genesis iteration
