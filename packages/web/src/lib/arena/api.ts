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
  | "HP_UPDATED";

/// Structured payload on HP_UPDATED events. The web treats the polled
/// `/tokens` response as the authoritative cohort (rank, status, prices) and
/// overlays the live HP from these events onto each row — see
/// `useHpUpdates` + `mergeHpUpdates`. `computedAt` is unix-seconds at the
/// indexer's block-time, used to tie-break stale-vs-fresh when both polls
/// and SSE messages arrive interleaved.
export type HpUpdatedData = {
  /// 0–100 integer (matches TokenResponse.hp).
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
