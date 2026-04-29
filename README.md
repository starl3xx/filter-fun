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

## Championship Structure

filter.fun runs on three escalating timescales:

### Weekly Seasons
Every week, tokens compete. Most get filtered. One gets funded. The weekly winner qualifies for the quarterly Filter Bowl.

### Quarterly Filter Bowl
At the end of each quarter, that quarter's weekly winners compete against each other. The same filter logic applies: finalists compete, weaker winners are filtered, tournament liquidity accumulates, one quarterly champion gets funded. Quarterly champions qualify for the annual championship.

### Annual Championship
After four quarterly champions exist, they compete in the annual championship. One token becomes the annual champion.

### Important
**Championship tournaments do not automatically destroy organic liquidity from established tokens.** Quarterly + annual settlement applies to tournament-controlled liquidity, reserves, and eligible allocations only — entry stakes, fee shares, and protocol-seeded prize pools — never the organic LP that holders are trading against. This protects existing winner markets while still allowing capital to consolidate into champions.

> Weekly creates winners. Quarterly creates assets. Annual creates legends.

### Tournament infrastructure

- **`TournamentRegistry`** is the metadata layer for the ladder. Every weekly settlement automatically marks the winner as `WEEKLY_WINNER` and every filter event marks losers as `FILTERED`. The oracle records quarterly finalists; the `TournamentVault` records the quarterly champion atomically at settlement. The registry is the source of truth that all settlement contracts read from for qualification.
- **`TournamentVault`** is the singleton settlement layer for both the **quarterly Filter Bowl** (per-(year, quarter)) and the **annual championship** (per-year). Pots are funded permissionlessly via `fundQuarterly` / `fundAnnual` (entry stakes, fee shares forwarded by the protocol, protocol-seeded prize pools — never an automatic unwind of organic LP). Settlement applies the same 2.5% champion bounty + 45/25/10/10/10 split as weekly: rollover + bonus paid via Merkle proofs (WETH-denominated for genesis), mechanics + treasury immediate, POL slice accumulates as WETH for a follow-up POL deployment path. `submitQuarterlyWinner` stamps `QUARTERLY_CHAMPION` on the registry (the gate to annual eligibility); `submitAnnualWinner` stamps the terminal `ANNUAL_CHAMPION`.

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

| Contract                | Role                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `FilterLauncher`        | Top-level. Season state machine. Per-wallet caps. Launches the protocol token ($FILTER).          |
| `FilterFactory`         | Single-tx ERC-20 deploy → V4 pool init → seed single-sided LP → per-token `FilterLpLocker`.       |
| `FilterHook`            | V4 hook gating add/remove-liquidity to the factory (seed) and locker (post-seed) only.            |
| `FilterLpLocker`        | Per-token. Holds the V4 LP. Splits collected fees 4-way (prize/treasury/mechanics/creator).      |
| `SeasonVault`           | Per-season escrow. Multi-filter event accounting. Champion bounty. Rollover Merkle claims.       |
| `SeasonPOLReserve`      | Per-season WETH-only POL holder. Accumulates the POL slice across filter events.                  |
| `POLManager`            | Singleton orchestrator. Turns each season's POL WETH into a permanent V4 LP position on the winner. |
| `POLVault`              | Singleton accounting layer. Records per-season `(winner, weth, tokens, liquidity)` deployments.   |
| `BonusDistributor`      | 14-day hold-bonus payout via multi-snapshot Merkle roots posted by the oracle.                    |
| `CreatorRegistry`       | Singleton (token → creator + launchedAt). Permanent record set by the launcher at launch.         |
| `CreatorFeeDistributor` | Singleton sink for the 0.20% creator slice of every swap. 72h eligibility, filter-aware.          |
| `TournamentRegistry`    | Singleton metadata layer. Per-token status across weekly → quarterly → annual ladder.            |
| `TournamentVault`       | Singleton settlement vault for the quarterly Filter Bowl + annual championship. Per-(year, quarter) and per-year WETH escrow + 45/25/10/10/10 split + Merkle rollover/bonus claims. |
| `TreasuryTimelock`      | OZ `TimelockController` on the treasury cut. 48h delay.                                           |

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
2.5% champion bounty → off-the-top; paid to the WINNER's creator at submitWinner

Then the remaining 97.5% splits per the user-aligned BPS:
45% rollover         → accumulate as WETH; buy winner tokens at final settlement, distribute via Merkle
25% bonus            → accumulate as WETH; forward to BonusDistributor at final settlement
10% mechanics        → WETH to events/missions wallet (immediate)
10% POL              → accumulate as WETH in SeasonPOLReserve; deploy at final settlement only
10% treasury         → WETH to TreasuryTimelock (immediate)
```

80% of every losers-pot dollar is user-aligned (rollover + bonus + mechanics) and 2.5% goes to the winner's creator. POL is silent during the week — accumulates as WETH, never deployed mid-competition. At final settlement the reserve is drained and handed to `POLManager`, which swaps half to winner tokens and adds a permanent V4 LP position on the winner pool (keyed by `POL_SALT` so it doesn't collide with the seed). The position itself stays inside the winner's `FilterLpLocker`; `POLVault` records the `(winner, weth, tokens, liquidity)` tuple per season for indexer + UI visibility. Trading-fee streams are separate; `processFilterEvent` only splits the WETH delta produced by the loser liquidations.

POL is intentionally permanent in this iteration: the LP stays in the locker forever. There is no withdraw, no rotation, no discretionary timing. Yield routing and capped mechanics funding are deliberately out of scope for genesis.

### Trading fee allocation (every swap, at `collectFees` time)

```
2.00% trading fee = 200 BPS, split on the WETH-side leg as:
  0.90% → prize pool (SeasonVault)
  0.65% → TreasuryTimelock
  0.25% → mechanics
  0.20% → CreatorFeeDistributor (eligible token's creator, within 72h of launch and pre-filter)
```

The token-leg fee dust is routed entirely to the season vault — too small in $ terms to merit a per-recipient split. Creator-fee accrual is auto-redirected to treasury once a token is filtered or 72h have elapsed since launch.

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
