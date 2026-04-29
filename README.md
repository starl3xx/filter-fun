# filter.fun 🔻

A competitive, weekly token-launcher game on Base. Anyone deploys a token, off-chain scoring ranks them, the top N pass the filter, one wins. Capital from losing tokens isn't destroyed — it's filtered and redirected into the winner via automatic rollover plus a 14-day hold bonus.

> Most get filtered. One gets funded. 🔻

## How filter.fun works 🔻

### 1. Launch & Trade
Tokens are launched and traded all week.
Every trade adds to a shared pool.

### 2. Tokens Get Filtered 🔻
As the week progresses, weaker tokens are eliminated.
Their liquidity is removed and added to the pool.

### 3. The Pool Grows
All filtered tokens + trading fees build a **growing reward pool**.

> The more tokens fail, the bigger the reward.

### 4. One Winner Emerges
At the end of the week, one token wins.

- filtered users → automatically rolled into the winner
- hold your tokens → earn a bonus

> Losing doesn't end your game — it rolls you forward.

### 5. Winner Gets Funded
The winner receives:
- massive buy pressure from the pool
- protocol-backed liquidity
- full market attention

> **Most get filtered. One gets funded. 🔻**

## Repo layout

```
packages/
├── contracts/     Foundry / Solidity 0.8.26 / Uniswap V4
├── oracle/        Settlement + bonus payload builders (Merkle, pro-rata)
├── scheduler/     viem-based on-chain driver (phase, settlement, bonus arcs)
├── indexer/       Ponder event indexer
├── scoring/       HP engine — velocity, effective buyers, sticky liq, retention, momentum
└── web/           Next.js 14 + wagmi v2 — broadcast leaderboard + claim flows
```

Each package has its own README. Cross-package contracts are intentional: the oracle ⇆ scheduler ⇆ web stack shares ABIs and Merkle leaf formats, and the per-package READMEs document the seams.

## Architecture

### On-chain — Uniswap V4-native, **not** a clanker wrap

| Contract             | Role                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `FilterLauncher`     | Top-level. Season state machine. Per-wallet caps. Launches the protocol token ($FILTER).          |
| `FilterFactory`      | Single-tx ERC-20 deploy → V4 pool init → seed single-sided LP → per-token `FilterLpLocker`.       |
| `FilterHook`         | V4 hook gating add/remove-liquidity to the factory (seed) and locker (post-seed) only.            |
| `FilterLpLocker`     | Per-token. Holds the V4 LP. Splits collected fees per BPS. Exposes liquidate-to-WETH primitives.  |
| `SeasonVault`        | Per-season escrow. Multi-filter event accounting. Allocates pot. Serves rollover Merkle claims.   |
| `SeasonPOLReserve`   | Per-season WETH-only POL holder. Accumulates the 10% slice across filter events.                  |
| `POLVault`           | Singleton. Receives winner-token POL exposure across all seasons.                                 |
| `BonusDistributor`   | 14-day hold-bonus payout via multi-snapshot Merkle roots posted by the oracle.                    |
| `TreasuryTimelock`   | OZ `TimelockController` on the 10% treasury cut. 48h delay.                                       |

All settlement-side accounting is **WETH**: pot, treasury, mechanics, bonus reserve, rollover all denominated and held in WETH.

### Off-chain stack

```
indexer → scoring → oracle → scheduler → contracts
                       ↓
                      web (claim flows)
```

- **indexer** ingests `FilterLauncher`, `SeasonVault`, `FilterLpLocker`, `BonusDistributor` events into a Postgres-backed query layer (Ponder, factory pattern).
- **scoring** consumes per-token aggregated metrics → ranked leaderboard. The HP composite is velocity (decayed net buys, sybil-dampened, churn-discounted) + effective buyers (log-flattened, dust-filtered) + sticky liquidity (time-weighted, withdrawal-penalized) + retention (two-anchor) + momentum (capped). Phase-aware weights — pre-filter rewards discovery, finals rewards conviction. Mcap is intentionally **not** an input: a token with strong distributed demand beats a whale-pumped fat one.
- **oracle** builds the on-chain payloads:
  - `buildFilterEventPayload` — per-cut: losers + per-loser min-out floors.
  - `buildSettlementPayload` — final cut: winner + cumulative rollover Merkle root over `(user, share)` leaves + slippage guards for the rollover and POL swaps.
  - `buildBonusPayload` — eligibility check across N snapshots (default ≥80% across snapshots), pro-rata allocation by **rollover amount only**, Merkle root over `(user, amount)` leaves.
  - `splitSettlementForPublication` / `splitBonusForPublication` — emits per-user JSON entries the web app consumes.
- **scheduler** drives the contracts:
  - `runPhaseArc` — `startSeason → advancePhase(Filter) → setFinalists → advancePhase(Finals) → advancePhase(Settlement)`.
  - `runFilterEvent` — one `processFilterEvent` tx per cut.
  - `runSettlement` — `processFilterEvent* → submitWinner` (drains rollover/bonus/POL reserves in one tx).
  - `postBonusRoot` / `claimBonus` — bonus arc on `BonusDistributor`.
- **web** turns the oracle's published per-user JSON entries into signed claim transactions (rollover + 14-day bonus), with on-chain `claimed[]` reads to disable already-completed claims.

### Losers-pot allocation (applied at every filter event)

```
45% rollover  → accumulate as WETH; buy winner tokens at final settlement, distribute via Merkle
25% bonus     → accumulate as WETH; forward to BonusDistributor at final settlement
10% mechanics → WETH to events/missions wallet (immediate)
10% POL       → accumulate as WETH in SeasonPOLReserve; deploy at final settlement only
10% treasury  → WETH to TreasuryTimelock (immediate)
```

80% of every losers-pot dollar is user-aligned (rollover + bonus + mechanics). POL is silent during the week — accumulates as WETH, never deployed mid-competition. At final settlement the reserve is drained, used to buy winner tokens, and parked in `POLVault`. Trading-fee streams are separate; `processFilterEvent` only splits the WETH delta produced by the loser liquidations.

### Trust model

- Oracle (2-of-3 multisig) submits per-season settlement payloads.
- 24h timelock on settlement payloads (off-contract; enforced via `liquidationDeadline`).
- Off-chain scoring algorithm + inputs published before each season opens. Trust comes from reproducibility.
- Memecoin game, not Curve. Don't overengineer.

## Working in the repo

```sh
npm install                                # workspace install
npm run build:contracts                    # forge build
npm run test:contracts                     # forge test (31 tests, V4 integration included)
npm --workspace @filter-fun/oracle test    # 30 tests
npm --workspace @filter-fun/scheduler test # 25 tests
npm --workspace @filter-fun/scoring test   # 14 tests
npm --workspace @filter-fun/web build      # Next.js production build
```

## CI

- `.github/workflows/contracts-ci.yml` — Foundry build + full test suite + `forge fmt --check` on every PR touching `packages/contracts/**`.
- `.github/workflows/off-chain-ci.yml` — typecheck + test for oracle / scheduler / scoring / web, plus `ponder codegen` for the indexer (catches schema/ABI/config drift).

## $FILTER

Week 1's protocol-launched seed token. Deployed via `script/LaunchFilterToken.s.sol` immediately after `DeployGenesis`. Plays the season like any other token — can win or lose. No on-chain privilege beyond bypassing the per-wallet launch cap.

## Status

Genesis iteration ships:

- ✅ V4 contract suite, full lifecycle tested (single + multi-loser settlement, bonus distribution, claim flows).
- ✅ Off-chain stack: oracle payload builders + scheduler drivers, both with tests.
- ✅ Web app: scaffold + rollover claim + bonus claim with on-chain status display.
- ✅ Indexer scaffolded; codegen sanity-checked in CI. Runtime tests deferred to first testnet deploy.
- ⏳ Base Sepolia / mainnet deploy.
- ⏳ Leaderboard + finals UI in web (needs indexer HTTP API).
- ⏳ Operator runbook for season ops.
