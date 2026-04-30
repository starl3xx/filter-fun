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

export const INDEXER_URL = (process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:42069").replace(/\/+$/, "");

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
  championPool: string;
  /// Decimal-ether string. Champion Backing Pool — currently "0" until the
  /// indexer's POL-slice tracking lands. UI handles "0" as the empty state.
  polReserve: string;
};

// ============================================================ /tokens

export type TokenStatus = "SAFE" | "AT_RISK" | "FINALIST" | "FILTERED";

export type TokenResponse = {
  token: `0x${string}`;
  /// Already prefixed with `$` (e.g. "$FILTER").
  ticker: string;
  /// 1-based; 0 means unscored (launch phase or empty cohort).
  rank: number;
  /// 0–100 integer.
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
  | "PHASE_ADVANCED";

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
  return fetchJson<SeasonResponse>(`${INDEXER_URL}/season`, opts);
}

export async function fetchTokens(opts: FetchOpts = {}): Promise<TokenResponse[]> {
  return fetchJson<TokenResponse[]>(`${INDEXER_URL}/tokens`, opts);
}

async function fetchJson<T>(url: string, opts: FetchOpts): Promise<T> {
  const res = await fetch(url, {signal: opts.signal, cache: "no-store"});
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

// ============================================================ Uniswap deep link

/// Build an Uniswap interface deep-link for `Trade $TICKER`. The custom V4
/// routing through FilterHook is a follow-up PR (spec §19.8) — this opens the
/// stock interface against the token address on the configured chain.
///
/// `chain` matches the wagmi `NEXT_PUBLIC_CHAIN` env: `"base"` or
/// `"base-sepolia"`. Uniswap's interface accepts the chain name in its
/// `chain=` query param.
export function uniswapTradeUrl(
  tokenAddress: `0x${string}`,
  chain: "base" | "base-sepolia",
): string {
  const params = new URLSearchParams({
    outputCurrency: tokenAddress,
    chain,
  });
  return `https://app.uniswap.org/#/swap?${params.toString()}`;
}
