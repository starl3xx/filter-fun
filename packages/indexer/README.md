# @filter-fun/indexer

Ponder-based on-chain event indexer for filter.fun. Consumes `FilterLauncher`, `SeasonVault`, `FilterLpLocker`, and `BonusDistributor` events into a Postgres-backed query layer, and serves a small HTTP API the web app + scheduler poll for live state.

## Layout

- `ponder.config.ts` — networks, contracts, factory patterns. Reads addresses from env.
- `ponder.schema.ts` — `season`, `token`, `feeAccrual`, `phaseChange`, `liquidation`, `rolloverClaim`, `bonusFunding`, `bonusClaim`.
- `src/*.ts` — event handlers grouped by source contract.
- `src/api/*.ts` — HTTP API (Epic 1.3 parts 1+2+3/3): `/season`, `/tokens`, `/token/:address`, `/profile/:address`, `/events` (SSE). Pure handlers in `handlers.ts`/`profile.ts`/`builders.ts`/`hp.ts`/`status.ts`/`phase.ts`; route wiring + Drizzle adapter in `index.ts`. Cross-cutting concerns (LRU cache, per-IP rate limit, IP resolution) live in `cache.ts`/`ratelimit.ts`/`middleware.ts`.
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

### Pointing at a deployed network

The indexer reads contract addresses from a deploy manifest produced by
[`packages/contracts/script/DeploySepolia.s.sol`](../contracts/script/DeploySepolia.s.sol)
(or, on mainnet, the legacy DeployGenesis output). Resolution order, in
[`src/deployment.ts`](./src/deployment.ts):

1. `DEPLOYMENT_MANIFEST_PATH` env (explicit absolute path — Docker / Railway).
2. Monorepo default: `../contracts/deployments/<network>.json`.
3. Env-var fallback: `FILTER_LAUNCHER_ADDRESS` / `FILTER_FACTORY_ADDRESS` /
   `BONUS_DISTRIBUTOR_ADDRESS` / `DEPLOY_BLOCK`. Set
   `DEPLOYMENT_MANIFEST_REQUIRED=1` to refuse fallback.

```sh
# Base Sepolia: just deploy and run.
PONDER_NETWORK=baseSepolia PONDER_RPC_URL_84532=$BASE_SEPOLIA_RPC_URL npm run dev

# Mainnet: same pattern, with the mainnet manifest in place.
PONDER_NETWORK=base PONDER_RPC_URL_8453=$BASE_RPC_URL npm run start
```

The boot log prints the resolved launcher/factory addresses and the deploy commit hash —
a quick way to verify you're indexing the manifest you think you are.

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
| `FILTER_COUNTDOWN` | HIGH | Time-to-next-cut crosses below `EVENTS_FILTER_COUNTDOWN_THRESHOLD_SEC` (default 600s = 10 min). Edge-triggered: fires once per crossing |
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
- `EVENTS_FILTER_MOMENT_WINDOW_MS`, `EVENTS_FILTER_COUNTDOWN_THRESHOLD_SEC`

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

### `GET /profile/:address` (Epic 1.3 part 3/3)

Wallet-level stats. Powers the Arena profile page and feeds the leaderboard "creator badge" surfaces. Address is normalized to lowercase before lookup; mixed-case input is accepted. Unknown wallets return `200` with the all-zero shape — this is intentional, so the UI can render an empty profile for new wallets without leaking "is this address ever been a player" via status code. Malformed addresses return `400`.

```json
{
  "address": "0x…",
  "createdTokens": [
    {
      "token": "0x…",
      "ticker": "$EDGE",
      "seasonId": 1,
      "rank": 0,
      "status": "WEEKLY_WINNER",
      "launchedAt": "2026-04-29T18:00:00.000Z"
    }
  ],
  "stats": {
    "wins": 1,
    "filtersSurvived": 0,
    "rolloverEarnedWei": "0",
    "bonusEarnedWei": "0",
    "lifetimeTradeVolumeWei": "0",
    "tokensTraded": 0
  },
  "badges": ["CHAMPION_CREATOR"],
  "computedAt": "2026-04-30T22:00:00.000Z"
}
```

`createdTokens[].status` precedence:

1. `liquidated` → `FILTERED`
2. `season.winner === token` → `WEEKLY_WINNER`
3. otherwise → `ACTIVE`

`QUARTERLY_FINALIST`/`QUARTERLY_CHAMPION`/`ANNUAL_FINALIST`/`ANNUAL_CHAMPION` statuses are part of the wire-format enum but are not yet emitted — the championship registry index lands in Epic 1.5.

`badges` derives from `createdTokens`. `CHAMPION_CREATOR` fires when the wallet created any token whose status is `WEEKLY_WINNER`. Other badges (`WEEK_WINNER` for token holders at finalize, `FILTER_SURVIVOR` for first-cut survivors, plus the tournament-tier badges) require holder-snapshot + tournament indexes that aren't built yet — see "Known gaps" below.

`stats.rolloverEarnedWei` aggregates `rolloverClaim.winnerTokens` per wallet (winner-token wei units; future Epic 1.10 will map these to WETH-equivalent). `stats.bonusEarnedWei` aggregates `bonusClaim.amount` (always WEI directly). `filtersSurvived`, `lifetimeTradeVolumeWei`, and `tokensTraded` ship as `0`/`"0"` until the holder-snapshot and swap-event indexes ship.

## Caching (Epic 1.3 part 3/3)

`/season`, `/tokens`, and `/profile/:address` are wrapped in an in-process LRU+TTL cache. The cache is single-instance — single Ponder process, no redis. The `Cache` interface in `cache.ts` is intentionally narrow so a redis-backed implementation can drop in later without touching call sites.

Every cacheable response carries an `X-Cache` header:

| Value | Meaning |
|---|---|
| `HIT` | Served from cache, body is unchanged from the last fresh compute |
| `MISS` | Cache had no entry (or it expired); recomputed and stored |
| `BYPASS` | Caller passed `?no-cache=1` (or `?nocache=1`) — fresh compute, *not* stored |

`/token/:address` is not cached — single-token detail is small and the address space is too large for a useful hit rate. `/events` is push-based and not cacheable.

Configuration knobs (env vars, optional with the defaults shown):

- `CACHE_TTL_SEASON_MS=3000` — `/season` TTL (3s; phase + countdown change quickly)
- `CACHE_TTL_TOKENS_MS=5000` — `/tokens` TTL (5s; leaderboard, fine to be slightly stale)
- `CACHE_TTL_PROFILE_MS=30000` — `/profile/:address` TTL (30s; profile data changes slowly)
- `CACHE_MAX_ENTRIES=10000` — LRU eviction cap (per-cache; `/season` and `/tokens` hold one entry each, `/profile` is the only multi-entry cache)

## Rate limiting (Epic 1.3 part 3/3)

Per-IP rate limit on every GET endpoint. `/events` is governed separately by a per-IP concurrent connection cap — counting an SSE stream against the request bucket would either let one client burn the bucket per minute or starve normal GETs.

**GET endpoints** (`/season`, `/tokens`, `/token/:address`, `/profile/:address`):
- Token bucket per IP, capacity `RATELIMIT_BURST` (default 10), refilling at `RATELIMIT_GET_PER_MIN / 60` tokens per second (default 60/min = 1 token/sec).
- Every response carries `RateLimit-Remaining: <integer>` so clients can self-throttle before hitting the cliff.
- On overflow: `429 Too Many Requests` with `Retry-After: <seconds>` (always ≥ 1, integer) and a JSON body `{"error":"rate limit exceeded","retryAfterSec":<n>}`.

**`/events`**:
- Per-IP concurrent connection cap, default `RATELIMIT_EVENTS_CONNS=5`.
- New connection at the cap: `429 Too Many Requests` with `Retry-After: 30`.
- Existing streams are not affected by hitting the cap — only the *new* connection is refused.
- Slots are released in a `finally` block so abnormal closes (network drop, refresh, server abort) don't leak slots.

**IP resolution**:
- Default: client IP comes from the immediate socket peer.
- `TRUST_PROXY=true` makes the limiter respect `X-Forwarded-For` (leftmost hop). Only enable this when the indexer sits behind a known reverse proxy — otherwise a client can spoof `X-Forwarded-For: <victim>` and burn another IP's budget. Railway sits behind a proxy, so set this to `true` in production.

Configuration knobs (env vars, optional with the defaults shown):

- `RATELIMIT_GET_PER_MIN=60` — sustained GET rate per IP
- `RATELIMIT_BURST=10` — burst capacity per IP
- `RATELIMIT_EVENTS_CONNS=5` — concurrent SSE connections per IP
- `TRUST_PROXY=false` — see "IP resolution" above

## Known gaps (Epic 1.3 parts 1+2+3/3)

The API is shipped with the spec §26.4 shape locked, but several fields currently surface placeholders because the underlying indexer schema doesn't track the relevant events yet. Documented here so callers know what is real vs. stand-in:

- **HP component values** depend on per-wallet swap streams + holder balances + LP-depth deltas, none of which are indexed today (the schema covers contract events: lifecycle, fees, claims). With degenerate inputs the cohort min-max normalization collapses to zeros across every component. Shape is correct (HP in [0, 1] → rendered as 0–100 integer; five components per token; phase weights applied), values are not. Fixing this is the indexer-expansion work that part 2/3 will need.
- **Market-data fields** on `/tokens` (`price`, `priceChange24h`, `volume24h`, `liquidity`, `holders`) are placeholders. Populating them requires the same swap/transfer/LP indexing as HP.
- **`polReserve`** on `/season` is `"0"` until POLManager / SeasonPOLReserve events are indexed. Schema has no POL accrual table yet.
- **Cadence anchors** (`nextCutAt`, `finalSettlementAt`) are derived from `season.startedAt` + spec §36.1.5 offsets (72h cut, 168h settlement). When Epic 1.10 lands and the contract emits explicit cadence anchors, swap the helpers in `phase.ts` for direct reads.
- **`/events` swap-derived signals** — once swap events are indexed (the same gap that blocks real HP), individual-trade detection can move from fee-derived inference to direct trade events (cleaner near-cut elevation, no dependency on `EVENTS_TRADE_FEE_BPS`). The locker→token resolution for fee-derived signals is now wired in `events/feeAdapter.ts` (joins `feeAccrual.token` against `token.locker` to map the per-token-locker emitter back to the token contract address) — both `recentFees`/`baselineFees` and the cumulative aggregation are populated from real data.
- **`/profile/:address` deferred fields** — `stats.filtersSurvived` (needs holder-snapshot index at first-cut time), `stats.lifetimeTradeVolumeWei` + `stats.tokensTraded` (need swap-event indexing), and the `WEEK_WINNER`/`FILTER_SURVIVOR`/`QUARTERLY_*`/`ANNUAL_*` badges (same indexes plus the championship registry from Epic 1.5) all ship as `0`/`"0"`/empty-set in genesis. The wire shape is locked so callers can render the full profile UI now and the indexer fills in real values as the underlying indexes land. Tracked as a follow-up issue on the Epic 1.3 part 3/3 PR.

## Status (genesis-of-indexer)

- Schema + handlers cover every event the contracts emit.
- HTTP API wired (Epic 1.3 complete — parts 1+2+3/3: `/season`, `/tokens`, `/token/:address`, `/profile/:address`, `/events` SSE, plus per-route LRU+TTL cache and per-IP token-bucket rate limit + `/events` connection cap).
- Factory pattern wired: `SeasonVault` instances tracked via `FilterLauncher.SeasonStarted`; `FilterLpLocker` instances tracked via `FilterFactory.TokenDeployed`.
- Addresses are placeholders — real wiring happens at testnet deploy.

## CI

Off-chain CI (`.github/workflows/off-chain-ci.yml`) runs `typecheck`, `codegen`, and `test` for this package on every PR. `codegen` is the load-bearing step for schema/ABI/config drift; `test` covers the pure API handlers via vitest fixtures (no RPC needed).

## Outstanding

- Indexer-side: track swap / transfer / LP events so HP inputs, market-data fields, `/events` volume baselines, and the `/profile` deferred fields (`filtersSurvived`, `lifetimeTradeVolumeWei`, `tokensTraded`, holder-derived badges) are real.
- Championship-tier badges + `QUARTERLY_*`/`ANNUAL_*` createdToken statuses on `/profile` — wired to the wire format but values land with Epic 1.5 (championship registry).
- `FilterFactory.TokenDeployed` adds the locker but doesn't index `FilterFactory` directly. If we want pool keys / start blocks per launch in the index, add a small handler.
