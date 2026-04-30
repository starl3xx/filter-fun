# @filter-fun/indexer

Ponder-based on-chain event indexer for filter.fun. Consumes `FilterLauncher`, `SeasonVault`, `FilterLpLocker`, and `BonusDistributor` events into a Postgres-backed query layer, and serves a small HTTP API the web app + scheduler poll for live state.

## Layout

- `ponder.config.ts` — networks, contracts, factory patterns. Reads addresses from env.
- `ponder.schema.ts` — `season`, `token`, `feeAccrual`, `phaseChange`, `liquidation`, `rolloverClaim`, `bonusFunding`, `bonusClaim`.
- `src/*.ts` — event handlers grouped by source contract.
- `src/api/*.ts` — HTTP API (Epic 1.3 part 1/3): `/season`, `/tokens`, `/token/:address`. Pure handlers in `handlers.ts`/`builders.ts`/`hp.ts`/`status.ts`/`phase.ts`; route wiring + Drizzle adapter in `index.ts`.
- `test/api/*.test.ts` — vitest unit tests against the pure handlers.
- `abis/*.json` — Foundry-extracted ABIs. Run `npm run abi:sync` after any contract change.

## Setup

```sh
npm install
cp .env.example .env  # fill in RPC + addresses post-deploy
npm run abi:sync
npm run codegen       # validates types against ABIs + schema
npm run dev           # local dev, requires deployed contracts + RPC
npm run test          # vitest unit tests for the API handlers
```

## HTTP API

Mounted on Ponder's built-in Hono server (default port 42069; set `PORT` to override). Base path is `/`.

### `GET /season`

Live state of the current weekly season — drives Arena top-bar countdowns, prize-pool figures, and phase indicators.

```json
{
  "seasonId": 2,
  "phase": "competition",
  "launchCount": 12,
  "maxLaunches": 12,
  "nextCutAt": "2026-04-30T14:00:00.000Z",
  "finalSettlementAt": "2026-05-04T14:00:00.000Z",
  "championPool": "14.82",
  "polReserve": "0"
}
```

| Field | Source | Notes |
|---|---|---|
| `seasonId` | `season.id` | Highest seasonId the indexer has seen — `FilterLauncher.startSeason` is monotonic |
| `phase` | `season.phase` (mapped) | `Launch → launch`, `Filter → competition`, `Finals → finals`, `Settlement/Closed → settled` |
| `launchCount` | `count(token where seasonId = X and !isProtocolLaunched)` | Excludes $FILTER and any future protocol seeds |
| `maxLaunches` | constant `12` | Mirrors `FilterLauncher.MAX_LAUNCHES` |
| `nextCutAt` | derived | `startedAt + 72h` (pre-finals) or `+ 168h` (finals) per spec §36.1.5 |
| `finalSettlementAt` | derived | `startedAt + 168h` |
| `championPool` | `totalPot − bonusReserve` | Both fields filled at `Finalized`; pre-finalize this is `0` |
| `polReserve` | placeholder `0` | POL accruals not yet indexed — see "Known gaps" below |

### `GET /tokens`

Cohort for the current season, sorted by ascending rank (rank 1 first). Matches spec §26.4 shape.

```json
[
  {
    "token": "0x…",
    "ticker": "$FILTER",
    "rank": 1,
    "hp": 82,
    "status": "SAFE",
    "price": "0",
    "priceChange24h": 0,
    "volume24h": "0",
    "liquidity": "0",
    "holders": 0,
    "components": {
      "velocity": 0.74,
      "effectiveBuyers": 0.62,
      "stickyLiquidity": 0.41,
      "retention": 0.55,
      "momentum": 0.50
    }
  }
]
```

`status` precedence (highest first):

1. `liquidated` (filter event unwound the LP) → `FILTERED`
2. `isFinalist` → `FINALIST`
3. rank ≤ 6 → `SAFE`
4. rank 7–9 → `AT_RISK`
5. rank ≥ 10 → `FILTERED` (about to be cut at next phase)

HP weights follow spec §6.5: `preFilter` weights during launch + competition, `finals` weights during finals + settled.

### `GET /token/:address`

Per-token detail — used by the leaderboard click-through. Returns `404` for any address the indexer has never seen, `400` for malformed addresses.

```json
{
  "token": "0x…",
  "ticker": "$FILTER",
  "name": "filter.fun",
  "seasonId": 1,
  "isProtocolLaunched": true,
  "isFinalist": false,
  "liquidated": false
}
```

## Known gaps (Epic 1.3 part 1/3)

The API is shipped with the spec §26.4 shape locked, but several fields currently surface placeholders because the underlying indexer schema doesn't track the relevant events yet. Documented here so callers know what is real vs. stand-in:

- **HP component values** depend on per-wallet swap streams + holder balances + LP-depth deltas, none of which are indexed today (the schema covers contract events: lifecycle, fees, claims). With degenerate inputs the cohort min-max normalization collapses to zeros across every component. Shape is correct (HP in [0, 1] → rendered as 0–100 integer; five components per token; phase weights applied), values are not. Fixing this is the indexer-expansion work that part 2/3 will need.
- **Market-data fields** on `/tokens` (`price`, `priceChange24h`, `volume24h`, `liquidity`, `holders`) are placeholders. Populating them requires the same swap/transfer/LP indexing as HP.
- **`polReserve`** on `/season` is `"0"` until POLManager / SeasonPOLReserve events are indexed. Schema has no POL accrual table yet.
- **Cadence anchors** (`nextCutAt`, `finalSettlementAt`) are derived from `season.startedAt` + spec §36.1.5 offsets (72h cut, 168h settlement). When Epic 1.10 lands and the contract emits explicit cadence anchors, swap the helpers in `phase.ts` for direct reads.

## Status (genesis-of-indexer)

- Schema + handlers cover every event the contracts emit.
- HTTP API wired (Epic 1.3 part 1/3).
- Factory pattern wired: `SeasonVault` instances tracked via `FilterLauncher.SeasonStarted`; `FilterLpLocker` instances tracked via `FilterFactory.TokenDeployed`.
- Addresses are placeholders — real wiring happens at testnet deploy.

## CI

Off-chain CI (`.github/workflows/off-chain-ci.yml`) runs `typecheck`, `codegen`, and `test` for this package on every PR. `codegen` is the load-bearing step for schema/ABI/config drift; `test` covers the pure API handlers via vitest fixtures (no RPC needed).

## Outstanding

- Indexer-side: track swap / transfer / LP events so HP inputs and market-data fields are real.
- `/events` SSE/websocket stream (Epic 1.3 part 2/3) for the ticker.
- `/profile/:address`, cache layer, rate limiting (Epic 1.3 part 3/3).
- `FilterFactory.TokenDeployed` adds the locker but doesn't index `FilterFactory` directly. If we want pool keys / start blocks per launch in the index, add a small handler.
