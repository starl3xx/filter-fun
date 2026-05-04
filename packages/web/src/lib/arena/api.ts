/// HTTP client for the indexer's spectator surface (Epic 1.3 PRs #29–#30).
///
/// Wire shapes mirror the server-side definitions exactly — see
/// `packages/indexer/src/api/builders.ts` (TokenResponse, SeasonResponse) and
/// `packages/indexer/src/api/events/types.ts` (TickerEvent). If the indexer's
/// payload shape changes, update both sides.
///
/// All endpoints are root-relative paths. The indexer runs on its own Railway
/// service; the web app reaches it via `NEXT_PUBLIC_INDEXER_URL`. In dev with
/// `ponder dev`, the default `http://localhost:42069` works out of the box.

// Use `||` not `??` (bugbot caught on PR #86): with the Docker ARG /
// ENV pattern that forwards Railway env vars into the build, an unset
// ARG still produces an empty string `""` (not `undefined`) in
// `process.env.NEXT_PUBLIC_INDEXER_URL`, which Next.js inlines into the
// bundle. `"" ?? fallback` evaluates to `""` because `??` only catches
// null/undefined, silently breaking the localhost fallback. `""`-aware
// `||` makes the fallback work for both "not set anywhere" (undefined,
// dev) and "declared as ARG without --build-arg" (empty string, Docker).
export const INDEXER_URL = (process.env.NEXT_PUBLIC_INDEXER_URL || "http://localhost:42069").replace(/\/+$/, "");

// ============================================================ /season

export type SeasonPhase = "launch" | "competition" | "finals" | "settled";

export type SeasonResponse = {
  seasonId: number;
  phase: SeasonPhase;
  launchCount: number;
  maxLaunches: 12;
  /// ISO8601 — next cut event for the current phase.
  nextCutAt: string;
  /// ISO8601 — final settlement timestamp (Day 7 anchor).
  finalSettlementAt: string;
  /// Decimal-ether string (e.g. "14.82"). Pre-finalize this is "0".
  /// Wire field stays `championPool` for indexer-API stability; surfaced in
  /// the UI as "Filter Fund" (spec §11.0). Consumers can prefer the
  /// `filterFund` alias below for new code.
  championPool: string;
  /// Alias for `championPool` — populated by `fetchSeason` (Epic 1.20). Not
  /// returned by the wire API; web-side derived so new components can use the
  /// post-§11.0 naming without each call site doing the rename inline.
  filterFund?: string;
  /// Decimal-ether string. Wire field stays `polReserve`; surfaced in the UI
  /// as "Filter Fund Liquidity Reserve" (spec §11.0). Currently "0" until the
  /// indexer's POL-slice tracking lands. UI handles "0" as the empty state.
  polReserve: string;
  /// Alias for `polReserve` — populated by `fetchSeason` (Epic 1.20). New
  /// components should prefer this field; existing consumers reading
  /// `polReserve` continue to work unchanged.
  filterFundLiquidityReserve?: string;
};

// ============================================================ /tokens

export type TokenStatus = "SAFE" | "AT_RISK" | "FINALIST" | "FILTERED";

/// Per-token bag-lock surface (Epic 1.13 — added to /tokens by PR #45). Mirrors
/// `BagLock` in `packages/indexer/src/api/builders.ts` — keep in sync.
///
///   isLocked         — `unlockTimestamp > nowSec` evaluated server-side at
///                      response time. Drives the badge / "Locked" copy on the
///                      arena and admin console.
///   unlockTimestamp  — unix-seconds the lock expires. `null` ONLY when the
///                      creator never committed a lock for this token (the row
///                      was absent from the indexer's `creator_lock` table).
///                      An expired-but-once-locked token surfaces a non-null
///                      timestamp with `isLocked: false` so the UI can render
///                      "unlocked since <date>" without a second round-trip.
///   creator          — the creator-of-record (`CreatorRegistry.creatorOf`).
///                      Echoed back so the badge tooltip can render
///                      "Creator <0xabcd…> locked" without a separate read.
export type BagLock = {
  isLocked: boolean;
  unlockTimestamp: number | null;
  creator: `0x${string}`;
};

export type TokenResponse = {
  token: `0x${string}`;
  /// Already prefixed with `$` (e.g. "$FILTER").
  ticker: string;
  /// 1-based; 0 means unscored (launch phase or empty cohort).
  rank: number;
  /// Integer in `[0, 10000]` (Epic 1.18 / spec §6.5 composite scale). Pre-1.18
  /// the wire range was 0-100; clients gating on absolute thresholds were
  /// updated in lockstep with the indexer.
  hp: number;
  status: TokenStatus;
  /// Decimal price strings — "0" until trade indexing lands.
  price: string;
  priceChange24h: number;
  volume24h: string;
  liquidity: string;
  holders: number;
  /// Raw [0,1] component scores. UI labels live in `hpLabels.ts` so the
  /// internal field names never reach the user (spec §6.6).
  components: {
    velocity: number;
    effectiveBuyers: number;
    stickyLiquidity: number;
    retention: number;
    momentum: number;
  };
  bagLock: BagLock;
};

// ============================================================ /events

export type EventPriority = "HIGH" | "MEDIUM" | "LOW";

export type EventType =
  | "RANK_CHANGED"
  | "CUT_LINE_CROSSED"
  | "HP_SPIKE"
  | "VOLUME_SPIKE"
  | "LARGE_TRADE"
  | "FILTER_FIRED"
  | "FILTER_COUNTDOWN"
  | "PHASE_ADVANCED"
  /// Epic 1.17b — fires on every hpSnapshot row write (per-swap, per-balance-
  /// change, per-block-tick, plus phase-boundary / CUT / FINALIZE recomputes).
  /// `priority: "LOW"` so LP-shedding under backpressure preserves HIGH events.
  /// Empty `message` — the data carrier is structured (see HpUpdatedData), not
  /// a ticker line.
  | "HP_UPDATED"
  // Epic 1.15a — reservation lifecycle. Emitted on `/season/:id/launch/stream`
  // (not on the global `/events` feed). `data.seasonId` carries the per-stream
  // filter key; the rest of `data` is type-specific.
  | "SLOT_RESERVED"
  | "SLOT_RELEASED"
  | "SLOT_REFUNDED"
  | "SLOT_REFUND_PENDING"
  | "SLOT_REFUND_CLAIMED"
  | "SLOT_FORFEITED"
  | "SEASON_ACTIVATED"
  | "SEASON_ABORTED";

/// Structured payload on HP_UPDATED events. The web treats the polled
/// `/tokens` response as the authoritative cohort (rank, status, prices) and
/// overlays the live HP from these events onto each row — see
/// `useHpUpdates` + `mergeHpUpdates`. `computedAt` is unix-seconds at the
/// indexer's block-time, used to tie-break stale-vs-fresh when both polls
/// and SSE messages arrive interleaved.
export type HpUpdatedData = {
  /// Integer in `[0, 10000]` (Epic 1.18) — matches TokenResponse.hp.
  hp: number;
  /// Raw [0,1] component scores — same shape as TokenResponse.components.
  components: {
    velocity: number;
    effectiveBuyers: number;
    stickyLiquidity: number;
    retention: number;
    momentum: number;
    holderConcentration: number;
  };
  weightsVersion: string;
  /// Unix-seconds — the block timestamp the recompute was based on.
  computedAt: number;
  /// Discriminator from `packages/indexer/src/api/hpRecompute.ts`.
  trigger: "BLOCK_TICK" | "SWAP" | "HOLDER_SNAPSHOT" | "PHASE_BOUNDARY" | "CUT" | "FINALIZE";
};

export type TickerEvent = {
  /// Monotonic per-process id from the indexer; doubles as SSE id.
  id: number;
  type: EventType;
  priority: EventPriority;
  /// `$TICKER` for token-scoped events, `null` for system events.
  token: string | null;
  address: `0x${string}` | null;
  /// Server-rendered, ready to display (icons inline).
  message: string;
  data: Record<string, unknown>;
  /// ISO8601 server-side wall clock at emission.
  timestamp: string;
};

// ============================================================ fetch helpers

type FetchOpts = {signal?: AbortSignal};

export async function fetchSeason(opts: FetchOpts = {}): Promise<SeasonResponse> {
  const raw = await fetchJson<SeasonResponse>(`${INDEXER_URL}/season`, opts);
  // Epic 1.20 (spec §11.0): populate user-facing field aliases so new
  // components can read `filterFund` / `filterFundLiquidityReserve` without
  // re-aliasing at every call site. The wire shape stays the same — these
  // are derived web-side and won't appear in the indexer JSON response.
  return {
    ...raw,
    filterFund: raw.championPool,
    filterFundLiquidityReserve: raw.polReserve,
  };
}

export async function fetchTokens(opts: FetchOpts = {}): Promise<TokenResponse[]> {
  return fetchJson<TokenResponse[]>(`${INDEXER_URL}/tokens`, opts);
}

async function fetchJson<T>(url: string, opts: FetchOpts): Promise<T> {
  const res = await fetch(url, {signal: opts.signal, cache: "no-store"});
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

/// Recover the HTTP status from a `fetchJson` rejection. The thrown Error
/// has shape `"<url> → <status>"`, so we anchor to the terminal segment —
/// a naive `\b(\d{3})\b` match would pick up a numeric identifier embedded
/// in the URL (e.g. a username like `123`) before the actual status code.
/// (Bugbot M PR #102 pass-7 caught this regression — Epic 1.24 usernames
/// can be all-digit; hex addresses pre-1.24 could not.)
export function fetchJsonErrorStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const m = err.message.match(/→\s*(\d{3})\s*$/);
  return m ? Number(m[1]) : null;
}

// ============================================================ /season/:id/tickers/check (Epic 1.15c)

/// Off-chain reproduction of the contract's `reserve` validation cascade. A
/// 200 with `ok: "available"` means the launch tx will land; the other `ok`
/// values pinpoint which gate failed:
///
///   - `available`     — passes every gate; safe to submit
///   - `blocklisted`   — multisig protocol blocklist (FILTER, WETH, ETH, ...)
///   - `winner_taken`  — won a prior season; cross-season reservation locked
///   - `season_taken`  — already reserved by another creator THIS season
///
/// 400 is reserved for malformed REQUESTS (missing/garbage ticker, bad season
/// id). The server normalises the input via the TS port of `TickerLib.normalize`
/// and surfaces `canonical` so the UI can render "We'll launch as $PEPE" before
/// the tx fires.
export type TickerCheckOk =
  | {ok: "available"; canonical: string; hash: `0x${string}`}
  | {ok: "blocklisted"; canonical: string; hash: `0x${string}`}
  | {ok: "winner_taken"; canonical: string; hash: `0x${string}`; reservedSeasonId: string}
  | {ok: "season_taken"; canonical: string; hash: `0x${string}`; reservedBy: `0x${string}`};

export type TickerCheckErr = {error: string; raw?: string};

export type TickerCheckResponse = TickerCheckOk | TickerCheckErr;

export async function fetchTickerCheck(
  seasonId: number | bigint | string,
  ticker: string,
  opts: FetchOpts = {},
): Promise<TickerCheckResponse> {
  const url = `${INDEXER_URL}/season/${seasonId}/tickers/check?ticker=${encodeURIComponent(ticker)}`;
  const res = await fetch(url, {signal: opts.signal, cache: "no-store"});
  // 200 + body shape carries the verdict; 400 surfaces format errors. Both
  // shapes return JSON — caller branches on `ok` vs `error`.
  return (await res.json()) as TickerCheckResponse;
}

// ============================================================ /season/:id/launch-status

/// Reservation lifecycle status for a single Reservation row, mirroring the
/// indexer schema's enum. The `status` value drives the slot-card badge.
export type ReservationStatus =
  | "PENDING"
  | "RELEASED"
  | "REFUNDED"
  | "REFUND_PENDING"
  | "REFUND_CLAIMED"
  | "FORFEITED";

export type ReservationRow = {
  creator: `0x${string}`;
  slotIndex: string;
  tickerHash: `0x${string}`;
  metadataHash: `0x${string}`;
  status: ReservationStatus;
  /// Decimal-wei.
  escrowAmountWei: string;
  /// Unix-seconds (decimal).
  reservedAt: string;
  /// Unix-seconds (decimal); null until status moves off PENDING.
  resolvedAt: string | null;
  /// Token address once status flipped to RELEASED.
  token: `0x${string}` | null;
};

export type LaunchStatusResponse = {
  seasonId: string;
  activated: boolean;
  aborted: boolean;
  /// Unix-seconds (decimal); null until the corresponding state event fires.
  activatedAt: string | null;
  abortedAt: string | null;
  reservationCount: number;
  /// Decimal-wei strings — sums across the season's reservations.
  totalEscrowedWei: string;
  totalReleasedWei: string;
  totalRefundedWei: string;
  totalRefundPendingWei: string;
  totalForfeitedWei: string;
  reservations: ReservationRow[];
};

export async function fetchLaunchStatus(
  seasonId: number | bigint | string,
  opts: FetchOpts = {},
): Promise<LaunchStatusResponse> {
  return fetchJson<LaunchStatusResponse>(
    `${INDEXER_URL}/season/${seasonId}/launch-status`,
    opts,
  );
}

// ============================================================ /wallet/:address/pending-refunds

export type PendingRefundRow = {
  /// Decimal seasonId (the contract argument is uint256).
  seasonId: string;
  /// Decimal-wei.
  amountWei: string;
  /// Unix-seconds (decimal).
  failedAt: string;
};

export type PendingRefundsResponse = {
  wallet: `0x${string}`;
  pending: PendingRefundRow[];
};

export async function fetchPendingRefunds(
  wallet: `0x${string}` | string,
  opts: FetchOpts = {},
): Promise<PendingRefundsResponse> {
  return fetchJson<PendingRefundsResponse>(
    `${INDEXER_URL}/wallet/${wallet}/pending-refunds`,
    opts,
  );
}

// ============================================================ /season/:id/launch/stream

/// SSE URL for the per-season reservation lifecycle stream. Pair with
/// `EventSource(launchStreamUrl(seasonId))` — the indexer broadcasts
/// `event: launch` frames whose `data` is a `TickerEvent` (with
/// SLOT_*/SEASON_* types). The hub already filters on seasonId server-side.
export function launchStreamUrl(seasonId: number | bigint | string): string {
  return `${INDEXER_URL}/season/${seasonId}/launch/stream`;
}

// ============================================================ /tokens/:address/history (PR #45)

/// One point in the per-token HP timeseries. Mirrors `HistoryPoint` in
/// `packages/indexer/src/api/history.ts` — keep the wire shape in sync.
export type HistoryPoint = {
  timestamp: number;
  hp: number;
  rank: number;
  phase: string;
  components: {
    velocity: number;
    effectiveBuyers: number;
    stickyLiquidity: number;
    retention: number;
    momentum: number;
  };
};

export type HistoryResponse = {
  token: `0x${string}`;
  from: number;
  to: number;
  interval: number;
  points: HistoryPoint[];
};

export type HistoryQuery = {
  from?: number;
  to?: number;
  interval?: number;
};

export async function fetchTokenHistory(
  tokenAddress: `0x${string}` | string,
  query: HistoryQuery = {},
  opts: FetchOpts = {},
): Promise<HistoryResponse> {
  const params = new URLSearchParams();
  if (query.from !== undefined) params.set("from", String(query.from));
  if (query.to !== undefined) params.set("to", String(query.to));
  if (query.interval !== undefined) params.set("interval", String(query.interval));
  const qs = params.toString();
  const url = qs
    ? `${INDEXER_URL}/tokens/${tokenAddress}/history?${qs}`
    : `${INDEXER_URL}/tokens/${tokenAddress}/history`;
  return fetchJson<HistoryResponse>(url, opts);
}

// ============================================================ /tokens/:address/component-deltas (Epic 1.23)

export type ComponentKey = "velocity" | "effectiveBuyers" | "stickyLiquidity" | "retention" | "momentum";

export type SwapImpactSwap = {
  side: "BUY" | "SELL";
  taker: `0x${string}`;
  /// Decimal-wei.
  wethValue: string;
  txHash: `0x${string}`;
};

export type SwapImpactRow = {
  timestamp: number;
  /// Component score delta vs the prior snapshot, in [-1, 1].
  delta: number;
  swap: SwapImpactSwap | null;
};

export type ComponentDeltasResponse = {
  token: `0x${string}`;
  computedAt: number;
  threshold: number;
  components: Record<ComponentKey, SwapImpactRow[]>;
};

export async function fetchComponentDeltas(
  tokenAddress: `0x${string}` | string,
  query: {limit?: number; threshold?: number} = {},
  opts: FetchOpts = {},
): Promise<ComponentDeltasResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.threshold !== undefined) params.set("threshold", String(query.threshold));
  const qs = params.toString();
  const url = qs
    ? `${INDEXER_URL}/tokens/${tokenAddress}/component-deltas?${qs}`
    : `${INDEXER_URL}/tokens/${tokenAddress}/component-deltas`;
  return fetchJson<ComponentDeltasResponse>(url, opts);
}

// ============================================================ /wallets/:address/holdings (Epic 1.23)

/// One position row from the indexer's per-wallet holdings response. The
/// `is*` flags + `projectedRolloverWeth` form the wire-shape contract; clients
/// derive the rendered status string from the flag set. Decimal-wei strings on
/// the wire side, decimal-ether strings (≤6 places) on the formatted variants.
export type HoldingsTokenRow = {
  address: `0x${string}`;
  /// Already prefixed with `$`.
  ticker: string;
  season: number;
  /// Decimal-wei.
  balance: string;
  /// Decimal-ether (≤6 places).
  balanceFormatted: string;
  isFiltered: boolean;
  isWinner: boolean;
  isFinalist: boolean;
  /// Decimal-wei or null. Null when projection isn't available — see
  /// `holdings.ts` in the indexer for the null-result rules.
  projectedRolloverWeth: string | null;
  /// Decimal-ether mirror of `projectedRolloverWeth`.
  projectedRolloverWethFormatted: string | null;
  /// True once the season's winner has been settled — the projection moves
  /// to the on-chain Merkle path (`/claim/rollover`) and is suppressed here.
  postSettlement: boolean;
};

export type HoldingsResponse = {
  wallet: `0x${string}`;
  /// Unix-seconds at which the indexer computed the response.
  asOf: number;
  tokens: HoldingsTokenRow[];
  /// Decimal-wei sum across non-null per-token projections.
  totalProjectedWeth: string;
  /// Decimal-ether mirror of `totalProjectedWeth`.
  totalProjectedWethFormatted: string;
};

export async function fetchHoldings(
  wallet: `0x${string}` | string,
  opts: FetchOpts = {},
): Promise<HoldingsResponse> {
  return fetchJson<HoldingsResponse>(
    `${INDEXER_URL}/wallets/${wallet}/holdings`,
    opts,
  );
}

// ============================================================ /profile/:address (Epic 1.23 — ?role=creator)

export type ProfileCreatedToken = {
  token: `0x${string}`;
  ticker: string;
  seasonId: number;
  rank: number;
  status:
    | "ACTIVE"
    | "FILTERED"
    | "WEEKLY_WINNER"
    | "QUARTERLY_FINALIST"
    | "QUARTERLY_CHAMPION"
    | "ANNUAL_FINALIST"
    | "ANNUAL_CHAMPION";
  launchedAt: string;
};

/// Epic 1.24 — userProfile block. Attached by `/profile/:identifier` (the
/// identifier-aware extension of `/profile/:address`). For pre-Epic-1.24
/// callers hitting `/profile/:address`, this field is absent — the helper
/// below normalizes that into a hasUsername=false block.
export type UserProfileBlock = {
  address: `0x${string}`;
  username: string | null;
  usernameDisplay: string | null;
  hasUsername: boolean;
};

export type ProfileResponse = {
  address: `0x${string}`;
  createdTokens: ProfileCreatedToken[];
  stats: {
    wins: number;
    filtersSurvived: number;
    rolloverEarnedWei: string;
    bonusEarnedWei: string;
    lifetimeTradeVolumeWei: string;
    tokensTraded: number;
  };
  badges: string[];
  computedAt: string;
  /// Epic 1.24 — present on responses from `/profile/:identifier`. Older
  /// indexer versions omit it; consumers should fall back to a default block.
  userProfile?: UserProfileBlock;
};

/// `?role=creator` returns ONLY the creator-keyed surface — `createdTokens` +
/// `wins` + `CHAMPION_CREATOR` badge if applicable. Trader-side stats are
/// zeroed so the consumer can rely on the response to reflect the role.
export async function fetchProfile(
  identifier: `0x${string}` | string,
  opts: FetchOpts & {role?: "creator"} = {},
): Promise<ProfileResponse> {
  const url = opts.role
    ? `${INDEXER_URL}/profile/${identifier}?role=${opts.role}`
    : `${INDEXER_URL}/profile/${identifier}`;
  return fetchJson<ProfileResponse>(url, {signal: opts.signal});
}

// ============================================================ Username surface (Epic 1.24)

/// Live availability check. The POST endpoint re-validates at write time, so
/// this is strictly informational — a slow user can hold an "available"
/// verdict that's stale by the time they submit. Cheap enough that the form
/// can call it on every keystroke (debounced).
export type UsernameAvailability =
  | {available: true}
  | {
      available: false;
      reason: "taken" | "blocklisted" | "invalid-format";
      formatDetail?:
        | "too-short"
        | "too-long"
        | "invalid-chars"
        | "empty";
    };

export async function fetchUsernameAvailability(
  username: string,
  opts: FetchOpts = {},
): Promise<UsernameAvailability> {
  const url = `${INDEXER_URL}/profile/username/${encodeURIComponent(username)}/available`;
  return fetchJson<UsernameAvailability>(url, {signal: opts.signal});
}

/// `POST /profile/:address/username`. The wallet client signs
/// `filter.fun:set-username:<address>:<username>:<nonce>` with `personal_sign`.
/// The server recovers the signing address; if it doesn't equal `address`,
/// the request is rejected as `signature mismatch` (401).
export type SetUsernameError =
  | {error: "invalid request body" | "invalid address" | "invalid username format" | "blocklisted username" | "invalid JSON body"; detail?: string; status: 400}
  | {error: "signature mismatch"; status: 401}
  | {error: "taken"; status: 409}
  | {error: "cooldown-active"; nextEligibleAt?: string; status: 409}
  | {error: "identity layer unavailable"; status: 503}
  | {error: "internal error"; status: 500};

export async function submitUsername(args: {
  address: `0x${string}`;
  username: string;
  signature: `0x${string}`;
  nonce: string;
  signal?: AbortSignal;
}): Promise<
  | {ok: true; profile: UserProfileBlock}
  | {ok: false; error: SetUsernameError}
> {
  const url = `${INDEXER_URL}/profile/${args.address}/username`;
  const res = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      username: args.username,
      signature: args.signature,
      nonce: args.nonce,
    }),
    signal: args.signal,
  });
  // Read body once, regardless of status, so the caller has a structured
  // error envelope. Empty bodies (extremely rare — server always JSONs)
  // collapse to a status-only error.
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  if (res.ok) {
    const profile = (body as {profile?: UserProfileBlock} | null)?.profile;
    if (profile) return {ok: true, profile};
    return {ok: false, error: {error: "internal error", status: 500}};
  }
  const errBody = (body ?? {}) as Record<string, unknown>;
  return {
    ok: false,
    error: {
      error: (errBody.error ?? "internal error") as SetUsernameError["error"],
      status: res.status as 400 | 401 | 409 | 500 | 503,
      ...(typeof errBody.detail === "string" ? {detail: errBody.detail} : {}),
      ...(typeof errBody.nextEligibleAt === "string"
        ? {nextEligibleAt: errBody.nextEligibleAt}
        : {}),
    } as SetUsernameError,
  };
}

/// Compose the canonical signed-message body. The server constructs the
/// same string in `packages/indexer/src/api/username.ts:buildSetUsernameMessage`;
/// the wallet client signs this exact body via `personal_sign`. Lowercases
/// address + username so the signing client can be sloppy about casing.
///
/// SECURITY: this format is the load-bearing security boundary of the
/// identity layer (bugbot M PR #102 pass-5). If the two copies drift, every
/// `set-username` POST silently fails recovery (401 for all users). Both
/// packages pin the canonical output via a literal-format test:
///   - indexer: `test/api/username.test.ts` "formats with all fields lowercased"
///   - web:     `test/profile/SetUsernameMessageParity.test.ts`
/// If you change this string, change BOTH and update both tests in the same
/// commit — drift on either side will fail its own test before merge.
export function buildSetUsernameMessage(
  address: `0x${string}`,
  username: string,
  nonce: string,
): string {
  return `filter.fun:set-username:${address.toLowerCase()}:${username.toLowerCase()}:${nonce}`;
}

// ============================================================ Trade deep link

/// Build a "Trade $TICKER" deep-link for the configured chain.
///
/// On Base mainnet we point at the Uniswap interface — path-based routing
/// (`/swap?…`), which superseded the legacy hash-based `/#/swap?…` form
/// in 2023 — with `chain=base` and `outputCurrency` for the token.
///
/// On Base Sepolia, the Uniswap interface doesn't support the testnet, so
/// the link instead opens the token page on Sepolia Basescan. The detail
/// panel surfaces the link with a footnote noting that real swaps land
/// alongside the FilterHook-routed UI in a follow-up PR (spec §19.8).
///
/// Returns `{ url, label }` so the consumer can adjust the button copy
/// without re-deriving the chain.
export function tradeTokenUrl(
  tokenAddress: `0x${string}`,
  chain: "base" | "base-sepolia",
): {url: string; label: string} {
  if (chain === "base-sepolia") {
    return {
      url: `https://sepolia.basescan.org/token/${tokenAddress}`,
      label: "View on Basescan",
    };
  }
  const params = new URLSearchParams({
    outputCurrency: tokenAddress,
    chain: "base",
  });
  return {
    url: `https://app.uniswap.org/swap?${params.toString()}`,
    label: "Trade on Uniswap",
  };
}
