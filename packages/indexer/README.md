# @filter-fun/indexer

Ponder-based on-chain event indexer for filter.fun. Consumes `FilterLauncher`, `SeasonVault`, `FilterLpLocker`, and `BonusDistributor` events into a Postgres-backed query layer, and serves a small HTTP API the web app + scheduler poll for live state.

## Layout

- `ponder.config.ts` — networks, contracts, factory patterns, block intervals. Reads addresses from env.
- `ponder.schema.ts` — base lifecycle tables (`season`, `token`, `feeAccrual`, `phaseChange`, `liquidation`, `rolloverClaim`, `bonusFunding`, `bonusClaim`) plus enrichment tables (`pool`, `swap`, `hpSnapshot`, `holderBalance`, `holderSnapshot`, `creatorLock`, `tournamentStatus`, `tournamentQuarterEntrant`, `tournamentAnnualEntrant`).
- `src/*.ts` — event handlers grouped by source contract: `FilterLauncher`, `FilterFactory`, `FilterToken` (Transfer → holder balances), `SeasonVault`, `FilterLpLocker`, `BonusDistributor`, `CreatorCommitments`, `TournamentRegistry`, `V4PoolManager`, `HpSnapshot` (block interval).
- `src/api/*.ts` — HTTP API: `/season`, `/tokens`, `/token/:address`, `/tokens/:address/history`, `/profile/:address`, `/events` (SSE). Pure handlers in `handlers.ts`/`profile.ts`/`history.ts`/`builders.ts`/`hp.ts`/`status.ts`/`phase.ts`; route wiring + Drizzle adapter in `index.ts`. Cross-cutting concerns (LRU cache, per-IP rate limit, IP resolution) live in `cache.ts`/`ratelimit.ts`/`middleware.ts`.
- `src/api/events/*.ts` — `/events` stream: pure detectors + priority pipeline + connection hub + tick engine; SSE route in `events/index.ts`.
- `test/api/*.test.ts` — vitest unit tests against the pure handlers + events module.
- `abis/*.json` — Foundry-extracted ABIs. Run `npm run abi:sync` after any contract change. `V4PoolManager.ts` is hand-written (Uniswap V4 is an upstream dep, not part of `packages/contracts`).

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
| `nextCutAt` | derived | `startedAt + 96h` (pre-finals, Day 4 hard cut) or `+ 168h` (finals) per spec §36.1.5; override via `SEASON_HARD_CUT_HOUR` |
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
    },
    "bagLock": {
      "isLocked": true,
      "unlockTimestamp": 1730851200,
      "creator": "0x…"
    }
  }
]
```

`bagLock` is sourced from `creatorLock` rows the indexer mirrors from `CreatorCommitments.Committed` events (spec §38.5 / §38.7). `isLocked` is `unlockTimestamp > nowSec` evaluated at request time, so a freshly-expired lock surfaces as `false` without a re-index. Tokens whose creator never committed render `{isLocked: false, unlockTimestamp: null, creator: <launch creator>}`.

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

### `GET /tokens/:address/history`

HP timeseries for one token. Powers the admin console HP-component drilldown (Epic 1.11 v2) and the Arena sparkline. Backed by `hpSnapshot` rows the indexer writes on a periodic block-interval handler — default cadence is every 150 blocks (≈5 min on Base's 2s blocks); override via `HP_SNAPSHOT_INTERVAL_BLOCKS`.

```
GET /tokens/0xabc.../history?from=1700000000&to=1700604800&interval=300
```

Query params (all optional):

| Param | Default | Notes |
|---|---|---|
| `from` | `to - 7*24*60*60` | Unix seconds (inclusive) |
| `to` | `Math.floor(Date.now()/1000)` | Unix seconds (inclusive) |
| `interval` | `300` (5 min) | Bucket size in seconds; clamped to `[60, 86400]` |

Range cap: `to - from <= 30*24*60*60` (30 days). Larger ranges return `400`.

Response:

```json
{
  "token": "0xabc…",
  "from": 1700000000,
  "to":   1700604800,
  "interval": 300,
  "points": [
    {
      "timestamp": 1700000000,
      "hp": 82,
      "rank": 3,
      "phase": "competition",
      "components": {
        "velocity": 0.74,
        "effectiveBuyers": 0.62,
        "stickyLiquidity": 0.41,
        "retention": 0.55,
        "momentum": 0.50
      }
    }
  ]
}
```

Bucketing: snapshots are floor-aligned into `interval`-sized windows; the LATEST sample within each bucket wins. Empty buckets are absent (sparse output) — the renderer chooses to gap or interpolate.

Cache: shares the `/tokens` TTL (5s default). `?no-cache=1` forces BYPASS.

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
2. `tournamentStatus` from `TournamentRegistry` (when `!= ACTIVE`) — `QUARTERLY_FINALIST`/`QUARTERLY_CHAMPION`/`ANNUAL_FINALIST`/`ANNUAL_CHAMPION`/`WEEKLY_WINNER`
3. `season.winner === token` → `WEEKLY_WINNER` (legacy fallback before the registry has a row)
4. otherwise → `ACTIVE`

`badges`:

| Badge | Trigger |
|---|---|
| `CHAMPION_CREATOR` | wallet created any token whose status is `WEEKLY_WINNER` |
| `WEEK_WINNER` | wallet held the winning token at season finalize (`holderSnapshot.trigger = FINALIZE` × `season.winner`) |
| `FILTER_SURVIVOR` | wallet held any non-liquidated token at first cut (`holderSnapshot.trigger = CUT`) |
| `QUARTERLY_FINALIST` | wallet held any quarterly Filter Bowl entrant |
| `QUARTERLY_CHAMPION` | wallet held a quarterly champion |
| `ANNUAL_FINALIST` | wallet held an annual entrant — surface ships, but spec §33.8 leaves the annual settlement dormant |
| `ANNUAL_CHAMPION` | wallet held an annual champion — same dormancy caveat |

`stats`:

| Field | Source |
|---|---|
| `wins` | count of `createdTokens` with status `WEEKLY_WINNER` |
| `filtersSurvived` | distinct `seasonId` count from `holderSnapshot` rows where `holder = wallet AND trigger = CUT` |
| `rolloverEarnedWei` | sum of `rolloverClaim.winnerTokens` per wallet (winner-token wei units) |
| `bonusEarnedWei` | sum of `bonusClaim.amount` |
| `lifetimeTradeVolumeWei` | sum of `swap.wethValue` where `taker = wallet` |
| `tokensTraded` | distinct `swap.token` count for the same wallet |

## Cadence (Epic 1.10)

`nextCutAt` and `finalSettlementAt` in `/season` are computed as `season.startedAt + N hours`, where the hour anchors come from `@filter-fun/cadence` (the same module the scheduler reads, so the API can never disagree with the on-chain phase advances). The locked timeline:

- Hour 0–48: launch window
- Hour 48–96: trading-only
- Hour 96: hard cut (`nextCutAt` while in launch / competition)
- Hour 96–168: finals (`nextCutAt` shifts to the settlement anchor)
- Hour 168: settlement (`finalSettlementAt`)

Override via env at indexer startup (validated; bad values abort the process):

- `SEASON_LAUNCH_END_HOUR` (default `48`)
- `SEASON_HARD_CUT_HOUR` (default `96`; must be `> launchEnd`)
- `SEASON_SETTLEMENT_HOUR` (default `168`; must be `> hardCut`)
- `SEASON_SOFT_FILTER_ENABLED` (default `false`; spec §33.6 — Day 5 soft filter is OFF; flag is forward-compat only)

Mostly used to compress the timeline for Sepolia smoke tests — e.g. `SEASON_HARD_CUT_HOUR=2 SEASON_SETTLEMENT_HOUR=4` runs a season-in-an-hour. See [`packages/cadence/README.md`](../cadence/README.md) for the full env interface.

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

## Enrichment indexes (PR #45)

The schema beyond the base lifecycle tables is layered on for /profile (deferred fields), /tokens/:address/history, /tokens.bagLock, and tournament/holder-derived badges.

| Table | Driven by | Used for |
|---|---|---|
| `pool` | `FilterFactory.TokenDeployed` | Resolve V4 `Swap.id` → filter token + locker + creator |
| `swap` | `V4PoolManager.Swap` (filtered to filter pools via `pool` join) | `/profile.stats.lifetimeTradeVolumeWei` + `tokensTraded`; future direct-trade signals on `/events` |
| `hpSnapshot` | `HpSnapshot:block` (block-interval handler — default every 150 blocks) | `/tokens/:address/history` |
| `holderBalance` | `FilterToken.Transfer` (factory-pattern per launched token) | running per-(token, holder) balance — input to `holderSnapshot` |
| `holderSnapshot` | `SeasonVault.Liquidated` (first cut → CUT) + `SeasonVault.Finalized` (winner → FINALIZE) | `/profile.stats.filtersSurvived`, `WEEK_WINNER` + `FILTER_SURVIVOR` badges |
| `creatorLock` | `CreatorCommitments.Committed` | `/tokens.bagLock` |
| `tournamentStatus`, `tournamentQuarterEntrant`, `tournamentAnnualEntrant` | `TournamentRegistry` events | `/profile.createdTokens[].status` (tournament-tier) + `/profile.badges` (`QUARTERLY_*`, `ANNUAL_*`) |

Configurable via env:

| Var | Default | Notes |
|---|---|---|
| `HP_SNAPSHOT_INTERVAL_BLOCKS` | `150` | `hpSnapshot` write cadence (≈5 min on Base) |
| `HOLDER_SNAPSHOT_DUST_WEI` | `100000000000000` (1e14, ~0.0001 token) | Min balance for a holder to count in a snapshot |
| `CREATOR_COMMITMENTS_ADDRESS` | unset | Until the deploy manifest carries this address, set explicitly so `Committed` events land |
| `WETH_ADDRESS` | unset | Required for V4 Swap classification (BUY/SELL); sourced from the deploy manifest in production |

### Annual championship surface (spec §33.8)

The `ANNUAL_FINALIST` / `ANNUAL_CHAMPION` statuses + badges ship in the API + indexer schema even though spec §33.8 has the annual settlement *deferred indefinitely*. The decision is:

- The contracts (`TournamentRegistry.recordAnnualFinalists` / `recordAnnualChampion`) exist and are auth-gated to oracle/vault.
- The indexer subscribes to those events.
- /profile + /tokens reflect annual state if/when an oracle ever activates the surface.
- In practice today, all annual fields stay empty.

Shipping the surface dormant means the day the annual is activated, the API "just works" with zero changes — and clients render correctly today (badges array has a stable type).

### Testing notes

The Ponder block-interval and event handlers are exercised end-to-end on a real chain (testnet rehearsal); vitest covers only the pure handlers via fixture queries. `test_coverage_state.md` (project memory) documents the integration-test gap. The fixture pattern + queries-interface boundary is what makes the API surface testable without a running indexer — every new query (e.g. `swapAggregatesForUser`, `holderBadgeFlagsForUser`, `bagLocksForTokens`) flows through the same shape.

## Known gaps

The API ships with the spec shape locked. Some fields surface placeholders because the underlying indexer signal isn't fully wired:

- **HP component values** still rely on cohort min-max normalization with no swap/transfer/LP-depth inputs at the API tick boundary (the `/tokens` tick engine doesn't consume the new `swap` index yet — that's a follow-up that wires the same path the `events/feeAdapter.ts` uses for fees). The `hpSnapshot` writer derives values the same way so /tokens and /tokens/:address/history agree by construction.
- **Market-data fields** on `/tokens` (`price`, `priceChange24h`, `volume24h`, `liquidity`, `holders`) remain placeholders — derivable from `swap` + `holderBalance` once the /tokens builder reads them; tracked separately.
- **`polReserve`** on `/season` is `"0"` until POLManager / SeasonPOLReserve events are indexed.
- **Cadence anchors** (`nextCutAt`, `finalSettlementAt`) are derived from `season.startedAt` + offsets read from `@filter-fun/cadence` (96h cut, 168h settlement; override via env). The cadence package is the single source of truth shared with `@filter-fun/scheduler`.
- **V4 swap `taker` resolution** — `swap.taker` records the V4 `sender` (typically the universal router, not the EOA). `lifetimeTradeVolumeWei` therefore counts router activity until router-decoding lands (Track D). The schema is forward-compat: backfilling `taker` to the EOA later doesn't require a wire change.
- **V4 PoolManager filtering** — we currently subscribe to ALL Swap events from the singleton PoolManager and drop foreign pools at the handler boundary. On a busy mainnet this is wasteful. The eventual fix is a topic-based filter once we can enumerate filter.fun poolIds at config time. Acceptable for genesis where the indexer starts at our deploy block.
- **`/tokens/:address/holders` endpoint deferred to Phase 2 (audit finding C-4, Phase 1 audit 2026-05-01).** Spec §41.3 describes address-based concentration filtering, which presumes a paginated holders surface exists, and §22 / §26.4 reference the "holders" component of HP. The underlying `holderBalance` (per-(token, holder) running balance, indexed from `FilterToken.Transfer`) and `holderSnapshot` (CUT/FINALIZE captures from `SeasonVault`) tables are already populated, so the data exists — only the HTTP surface is missing. Deliberately deferred: (a) shape decisions (pagination cursor vs offset, dust threshold, bag-locked-creator inclusion) need the Phase-2 concentration filter to drive them; (b) shipping a half-spec endpoint now would create churn when the consumer arrives. Genesis frontends derive holder *counts* from `/tokens` placeholders (returning `0` until wired — see "Market-data fields" above) and do not need the holder *list*. To unblock Phase 2, see "Outstanding" below.

## Status (genesis-of-indexer)

- Schema + handlers cover every event the contracts emit.
- HTTP API wired (Epic 1.3 complete — parts 1+2+3/3: `/season`, `/tokens`, `/token/:address`, `/profile/:address`, `/events` SSE, plus per-route LRU+TTL cache and per-IP token-bucket rate limit + `/events` connection cap).
- Factory pattern wired: `SeasonVault` instances tracked via `FilterLauncher.SeasonStarted`; `FilterLpLocker` instances tracked via `FilterFactory.TokenDeployed`.
- Addresses are placeholders — real wiring happens at testnet deploy.

## CI

Off-chain CI (`.github/workflows/off-chain-ci.yml`) runs `typecheck`, `codegen`, and `test` for this package on every PR. `codegen` is the load-bearing step for schema/ABI/config drift; `test` covers the pure API handlers via vitest fixtures (no RPC needed).

## Outstanding

- Wire the new `swap` + `holderBalance` indexes into the `/tokens` HP tick engine + market-data placeholders (price/volume24h/liquidity/holders). The data is now indexed; the consumer is not.
- `polReserve` on `/season` — POLManager / SeasonPOLReserve events are still not indexed.
- V4 PoolManager swap filtering — index ALL swaps + filter at handler boundary today. Add a topic-based filter once factory-time poolId enumeration lands.
- Router → EOA decoding for `swap.taker` so `lifetimeTradeVolumeWei` reflects EOA activity rather than router activity (Track D).
- **Phase 2: `/tokens/:address/holders` endpoint** (audit finding C-4). Read from the existing `holderBalance` table; require pagination (cursor-based, since balance distributions are long-tailed); apply a dust cutoff aligned with `HOLDER_SNAPSHOT_DUST_WEI`; surface bag-locked creator entries with a flag rather than filtering them out. Land alongside the `/tokens` HP-tick wiring of the `holders` market-data field so the count and the list agree by construction.
