# @filter-fun/indexer

Ponder-based on-chain event indexer for filter.fun. Consumes `FilterLauncher`, `SeasonVault`, `FilterLpLocker`, and `BonusDistributor` events into a Postgres-backed query layer, and serves a small HTTP API the web app + scheduler poll for live state.

## Layout

- `ponder.config.ts` — networks, contracts, factory patterns. Reads addresses from env.
- `ponder.schema.ts` — `season`, `token`, `feeAccrual`, `phaseChange`, `liquidation`, `rolloverClaim`, `bonusFunding`, `bonusClaim`.
- `src/*.ts` — event handlers grouped by source contract.
- `src/api/*.ts` — HTTP API (Epic 1.3 parts 1+2/3): `/season`, `/tokens`, `/token/:address`, `/events` (SSE). Pure handlers in `handlers.ts`/`builders.ts`/`hp.ts`/`status.ts`/`phase.ts`; route wiring + Drizzle adapter in `index.ts`.
- `src/api/events/*.ts` — `/events` stream: pure detectors + priority pipeline + connection hub + tick engine; SSE route in `events/index.ts`.
- `test/api/*.test.ts` — vitest unit tests against the pure handlers + events module.
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

Mounted on Ponder's built-in Hono server (default port 42069; set `PORT` to override). Base path is `/`. Ponder reserves `/health`, `/ready`, `/status`, and `/metrics` for its own use; Railway's healthcheck targets `/health` (always 200 once the HTTP server is up, independent of indexer sync state).

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

### `GET /events` — Server-Sent Events stream (Epic 1.3 part 2/3)

Powers the Arena ticker (spec §20). Long-lived SSE stream of `TickerEvent` records. Each record uses the standard SSE framing:

```
id: 42
event: ticker
data: {"id":42,"type":"HP_SPIKE","priority":"MEDIUM",...}
```

Clients connect with the standard `EventSource` API. The browser handles auto-reconnect; the server emits a `:hb` SSE comment every `EVENTS_HEARTBEAT_MS` (default 15s) so reverse-proxy idle timeouts don't drop quiet streams. There is no server-side replay buffer — reconnects miss any events delivered during the disconnect window. Acceptable for genesis since the ticker is a "what's happening now" surface, not an audit log.

**Wire format** (per spec §26.4):

```json
{
  "id": 42,
  "type": "CUT_LINE_CROSSED",
  "priority": "HIGH",
  "token": "$EDGE",
  "address": "0x…",
  "message": "$EDGE just dropped below the cut line 🔻",
  "data": {"fromRank": 5, "toRank": 7, "direction": "below"},
  "timestamp": "2026-04-30T14:00:05.123Z"
}
```

**Event types + default priorities** (spec §36.1.4):

| Type | Priority | Trigger |
|---|---|---|
| `CUT_LINE_CROSSED` | HIGH | A token's rank crossed position 6 (the cut line) |
| `FILTER_FIRED` | HIGH | A token transitioned to liquidated — also arms a 60s "filter moment" suppression window |
| `FILTER_COUNTDOWN` | HIGH | < N min until the next cut |
| `RANK_CHANGED` | MEDIUM | A rank delta of ≥ `EVENTS_RANK_CHANGE_MIN` that didn't cross the cut line |
| `HP_SPIKE` | MEDIUM | `|Δhp|` ≥ `EVENTS_HP_SPIKE_THRESHOLD` between snapshots |
| `VOLUME_SPIKE` | MEDIUM | Current-window WETH fee / trailing baseline ≥ `EVENTS_VOLUME_SPIKE_RATIO` |
| `PHASE_ADVANCED` | MEDIUM | `season.phase` changed |
| `LARGE_TRADE` | LOW (MEDIUM near cut) | Inferred trade size ≥ `EVENTS_LARGE_TRADE_WETH` (`tradeWei = totalFee × 10000 / EVENTS_TRADE_FEE_BPS`); rank-7 ± window elevates to MEDIUM |

**Pipeline** runs once per detector tick (default `EVENTS_TICK_MS = 5000`) on top of the diffed snapshot. Stages, in order:

1. **Dedupe** — collapses repeated `(token, type)` pairs within `EVENTS_DEDUPE_WINDOW_MS` (default 30s)
2. **Throttle** — at most `EVENTS_THROTTLE_PER_TOKEN` (default 3) token-scoped events per `EVENTS_THROTTLE_WINDOW_MS`
3. **Filter-moment suppression** — after a `FILTER_FIRED`, all non-filter events drop for `EVENTS_FILTER_MOMENT_WINDOW_MS` (default 60s)
4. **LOW suppression** — if the surviving batch carries any HIGH/MEDIUM event, all LOW events from that batch drop (suppressed events do *not* burn dedupe/throttle slots — they reach the client cleanly on the next tick once things calm down)

**Backpressure** — every connection has a bounded queue of `EVENTS_PER_CONN_QUEUE_MAX` (default 200) events. When full, the hub evicts oldest LOW first, then oldest MEDIUM. **HIGH events are never evicted** — important signals always arrive even if the consumer is behind.

**Configuration knobs** (env vars, all optional with the defaults shown above):

- `EVENTS_TICK_MS`, `EVENTS_HEARTBEAT_MS`, `EVENTS_PER_CONN_QUEUE_MAX`
- `EVENTS_DEDUPE_WINDOW_MS`, `EVENTS_THROTTLE_WINDOW_MS`, `EVENTS_THROTTLE_PER_TOKEN`
- `EVENTS_HP_SPIKE_THRESHOLD`, `EVENTS_RANK_CHANGE_MIN`
- `EVENTS_VOLUME_SPIKE_RATIO`, `EVENTS_VOLUME_SPIKE_MIN_WETH` (decimal-ether: `"0.1"`)
- `EVENTS_LARGE_TRADE_WETH` (decimal-ether: `"0.5"`), `EVENTS_TRADE_FEE_BPS`
- `EVENTS_FILTER_MOMENT_WINDOW_MS`

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

## Known gaps (Epic 1.3 parts 1+2/3)

The API is shipped with the spec §26.4 shape locked, but several fields currently surface placeholders because the underlying indexer schema doesn't track the relevant events yet. Documented here so callers know what is real vs. stand-in:

- **HP component values** depend on per-wallet swap streams + holder balances + LP-depth deltas, none of which are indexed today (the schema covers contract events: lifecycle, fees, claims). With degenerate inputs the cohort min-max normalization collapses to zeros across every component. Shape is correct (HP in [0, 1] → rendered as 0–100 integer; five components per token; phase weights applied), values are not. Fixing this is the indexer-expansion work that part 2/3 will need.
- **Market-data fields** on `/tokens` (`price`, `priceChange24h`, `volume24h`, `liquidity`, `holders`) are placeholders. Populating them requires the same swap/transfer/LP indexing as HP.
- **`polReserve`** on `/season` is `"0"` until POLManager / SeasonPOLReserve events are indexed. Schema has no POL accrual table yet.
- **Cadence anchors** (`nextCutAt`, `finalSettlementAt`) are derived from `season.startedAt` + spec §36.1.5 offsets (72h cut, 168h settlement). When Epic 1.10 lands and the contract emits explicit cadence anchors, swap the helpers in `phase.ts` for direct reads.
- **`/events` swap-derived signals** — once swap events are indexed (the same gap that blocks real HP), individual-trade detection can move from fee-derived inference to direct trade events (cleaner near-cut elevation, no dependency on `EVENTS_TRADE_FEE_BPS`). The locker→token resolution for fee-derived signals is now wired in `events/feeAdapter.ts` (joins `feeAccrual.token` against `token.locker` to map the per-token-locker emitter back to the token contract address) — both `recentFees`/`baselineFees` and the cumulative aggregation are populated from real data.

## Status (genesis-of-indexer)

- Schema + handlers cover every event the contracts emit.
- HTTP API wired (Epic 1.3 parts 1+2/3 — `/season`, `/tokens`, `/token/:address`, `/events` SSE).
- Factory pattern wired: `SeasonVault` instances tracked via `FilterLauncher.SeasonStarted`; `FilterLpLocker` instances tracked via `FilterFactory.TokenDeployed`.
- Addresses are placeholders — real wiring happens at testnet deploy.

## CI

Off-chain CI (`.github/workflows/off-chain-ci.yml`) runs `typecheck`, `codegen`, and `test` for this package on every PR. `codegen` is the load-bearing step for schema/ABI/config drift; `test` covers the pure API handlers via vitest fixtures (no RPC needed).

## Outstanding

- Indexer-side: track swap / transfer / LP events so HP inputs, market-data fields, and `/events` volume baselines are real.
- `/profile/:address`, cache layer, rate limiting (Epic 1.3 part 3/3).
- `FilterFactory.TokenDeployed` adds the locker but doesn't index `FilterFactory` directly. If we want pool keys / start blocks per launch in the index, add a small handler.
