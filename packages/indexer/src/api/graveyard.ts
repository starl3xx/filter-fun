/// Pure handlers for `/graveyard` and `/graveyard/:address` — Epic 1.25.
///
/// Spec §7.3 (graveyard / archive) + §36.1.2 (filtered tokens stay tradable).
///
/// `/graveyard` is the cross-season archive of every filtered token. One row per
/// token. Powers the index page's grouped season list, the "closest near-misses"
/// hero strip, and the per-row near-miss callout. Pagination + sort + filter
/// (season, creator, ticker substring, near-miss-only) are query-driven.
///
/// `/graveyard/:address` is the per-token historical view. The full HP trajectory
/// across the token's season, the LP timeline (mints + burns from the indexed
/// liquidation event), holder-count over time, and the "how it ended" lifecycle
/// metadata used for the on-page recap card.
///
/// **Near-miss math (spec §36.3.3 / Epic 1.27 ≤5pp threshold).** A filtered token's
/// `nearMissMarginHp` is the integer HP gap between its final HP and the cut line
/// (the HP of the lowest token that survived CUT — typically rank 6 by spec §6).
/// We compute this from the CUT-trigger `hpSnapshot` rows: the cut line is
/// `min(hp)` over surviving tokens at CUT, and the margin is
/// `cutLineHp - finalHp` for filtered tokens. `isNearMiss = margin ≤ 500` (5pp on
/// the 0..10000 scale, per spec §36.3.3 "≤5 percentage points"). When the cut hasn't
/// happened yet (still pre-settlement) the field is null and `isNearMiss = false`
/// — narratives only attach post-cut, never mid-season (spec §36.3.3 don't-change).
///
/// **`tradableNow` (spec §36.1.2).** Filtered tokens remain tradable on their
/// canonical V4 pool with whatever organic LP remains. The indexer doesn't yet
/// stream pool reserves (deferred to V4 reads, Epic 1.X), so today this field
/// reflects the contract-level invariant: pool exists ⇒ tradable. Once V4 reads
/// land, this should narrow to "pool reserves > 0".

import {isAddressLike, tickerWithDollar, weiToDecimalEther} from "./builders.js";

// ============================================================ Constants

/// Near-miss / squeaker threshold per spec §36.3.3 / Epic 1.27. 500 = 5pp on the
/// 0..10000 HP composite scale (Epic 1.18). Filter-side: tokens that finished
/// within 500 HP of the cut line are flagged `isNearMiss`. Winner-side: winners
/// whose `winMarginHp ≤ 500` are flagged `isSqueaker` (`/winners` shape).
export const NEAR_MISS_THRESHOLD_HP = 500;

/// Default + max page size for `/graveyard`. Large enough to cover most single-
/// season cohorts (≤12 launches today) without forcing pagination on the typical
/// view; capped to keep response payload bounded.
export const GRAVEYARD_DEFAULT_PER_PAGE = 50;
export const GRAVEYARD_MAX_PER_PAGE = 200;

// ============================================================ /graveyard

/// One row in the `/graveyard` response. Cross-references the existing token +
/// season + CUT-snapshot data so the index page can render without follow-up
/// fetches.
export interface GraveyardTokenRow {
  address: `0x${string}`;
  ticker: string;
  season: number;
  creator: `0x${string}`;
  /// Resolved username + avatar from the off-chain identity layer (Epic 1.24).
  /// Null when the creator hasn't claimed a handle.
  creatorUsername: string | null;
  creatorAvatarUrl: string | null;
  /// Final rank within the cohort (1 = winner, ≥7 = filtered for a 12-launch
  /// season per the spec's #1-survives-the-cut model, may differ for smaller
  /// cohorts). Null for tokens we never scored (defensive — shouldn't happen).
  finalRank: number | null;
  /// `"CUT"` for tokens filtered at h96, `"FINALIZE"` for tokens filtered at
  /// h168 (the runner-ups in finals). Null when the token's filter event isn't
  /// yet indexed (rare; the row would have `liquidated = false` in that case
  /// and the graveyard query already excludes it).
  filterRound: "CUT" | "FINALIZE" | null;
  /// Unix-seconds at which this token's `Liquidated` event landed.
  filteredAt: number | null;
  /// Highest HP this token reached across the season. Sourced from the max HP
  /// over its hpSnapshot rows.
  peakHp: number;
  /// HP at the filter trigger (CUT or FINALIZE). For CUT-filtered tokens this
  /// is the integer HP from the CUT-tagged hpSnapshot row.
  finalHp: number;
  /// Integer HP gap between this token and the cut line — the spec §36.3.3
  /// near-miss anchor. Null when the season hasn't reached CUT (still
  /// pre-settlement) or we couldn't resolve a cut line.
  nearMissMarginHp: number | null;
  /// `nearMissMarginHp ≤ NEAR_MISS_THRESHOLD_HP`. False when `nearMissMarginHp
  /// === null` — narratives only attach post-cut.
  isNearMiss: boolean;
  /// Holder count snapshotted at the filter event (CUT or FINALIZE trigger).
  /// Surfaces on the row so the spectator can read "287 wallets held it at the
  /// cut" without a separate fetch.
  holdersAtFilter: number;
  /// Liquidation proceeds (decimal-ether). The WETH recovered from unwinding
  /// the LP, before bounty + rollover splits.
  lpReturnedWeth: string;
  /// Spec §36.1.2 — filtered tokens remain tradable on their canonical V4 pool.
  /// True today for every filtered token (the contract guarantees the pool
  /// keeps existing). Will narrow once V4 reads stream pool reserves.
  tradableNow: boolean;
}

export interface GraveyardResponse {
  asOf: number;
  tokens: GraveyardTokenRow[];
  total: number;
  page: number;
  perPage: number;
}

/// Sort discriminator. Default `recent` orders by most-recent `filteredAt`
/// (current season first → spectator's "what just happened" surface).
export type GraveyardSort =
  | "recent"
  | "season"
  | "rank"
  | "nearMissMargin"
  | "peakHp"
  | "creator";

export interface GraveyardParams {
  season?: string;
  creator?: string;
  ticker?: string;
  nearMiss?: string;
  sort?: string;
  page?: string;
  perPage?: string;
}

/// One filtered-token row pulled from the indexer + cohort joins. Pure handler
/// consumes this shape so vitest can drive without a Drizzle handle.
export interface GraveyardSourceRow {
  address: `0x${string}`;
  symbol: string;
  seasonId: bigint;
  creator: `0x${string}`;
  isFinalist: boolean;
  liquidationProceeds: bigint | null;
  /// Block timestamp of the token's `Liquidated` event (the filter moment).
  /// Resolved from the matching `liquidation` row keyed by `(seasonId, token)`.
  filteredAt: bigint | null;
  /// Highest HP this token reached in any indexed snapshot. Computed via a
  /// `max(hp)` aggregate over hpSnapshot[token=address].
  peakHp: number;
  /// HP at the filter trigger. Sourced from the latest CUT or FINALIZE-tagged
  /// hpSnapshot row for this token. Defaults to 0 for tokens where the trigger
  /// row isn't yet indexed.
  finalHp: number;
  /// `"CUT"` | `"FINALIZE"` from the trigger of the row that produced finalHp.
  filterRound: "CUT" | "FINALIZE" | null;
  /// Holder count at the filter trigger — distinct holders from the matching
  /// trigger-tagged holderSnapshot rows.
  holdersAtFilter: number;
  /// Cut line for this token's season — `min(hp)` over CUT-tagged snapshots
  /// where the producing token did NOT get filtered at CUT (i.e. survivors).
  /// Null when the season hasn't reached CUT yet.
  cutLineHp: number | null;
  /// Rank from the filter-trigger snapshot (the row that produced finalHp).
  /// Null when the trigger row's rank is unset (0 in storage). Powers the
  /// graveyard index "rank #N" caption per row — without this, the page
  /// rendered "rank #—" for every entry. Bugbot PR #103 pass-2.
  finalRank: number | null;
}

/// Profile lookup for creator avatar/username decoration. Mirrors the Epic 1.24
/// userProfile store shape but typed minimally so the queries adapter can stub
/// it without booting the pg pool.
export interface CreatorProfileLookup {
  username: string | null;
  avatarUrl: string | null;
}

export interface GraveyardQueries {
  /// Every filtered token across every indexed season. Implementation joins
  /// `token` × `liquidation` × `hpSnapshot` (CUT/FINALIZE-tagged) ×
  /// `holderSnapshot` to produce one row per token. Order is unspecified;
  /// the handler sorts.
  filteredTokens: () => Promise<GraveyardSourceRow[]>;
  /// Bulk creator-profile lookup, keyed by lowercased address. Tokens with
  /// no entry in the result map degrade to `{username: null, avatarUrl: null}`.
  creatorProfilesFor: (
    addresses: ReadonlyArray<`0x${string}`>,
  ) => Promise<Map<string, CreatorProfileLookup>>;
}

export async function getGraveyardHandler(
  q: GraveyardQueries,
  params: GraveyardParams,
  nowSec: () => number,
): Promise<{status: number; body: GraveyardResponse | {error: string}}> {
  const sort = parseSort(params.sort);
  if (sort === null) {
    return {status: 400, body: {error: `unknown sort: ${params.sort}`}};
  }

  let page = 1;
  if (params.page !== undefined) {
    const n = Number.parseInt(params.page, 10);
    if (!Number.isFinite(n) || n < 1) {
      return {status: 400, body: {error: "page must be a positive integer"}};
    }
    page = n;
  }

  let perPage = GRAVEYARD_DEFAULT_PER_PAGE;
  if (params.perPage !== undefined) {
    const n = Number.parseInt(params.perPage, 10);
    if (!Number.isFinite(n) || n < 1 || n > GRAVEYARD_MAX_PER_PAGE) {
      return {
        status: 400,
        body: {
          error: `perPage must be between 1 and ${GRAVEYARD_MAX_PER_PAGE}`,
        },
      };
    }
    perPage = n;
  }

  let seasonFilter: bigint | null = null;
  if (params.season !== undefined) {
    try {
      seasonFilter = BigInt(params.season);
      if (seasonFilter < 0n) throw new Error("negative");
    } catch {
      return {status: 400, body: {error: "invalid season id"}};
    }
  }

  let creatorFilter: `0x${string}` | null = null;
  if (params.creator !== undefined) {
    const lower = params.creator.toLowerCase();
    if (!isAddressLike(lower)) {
      // Username-keyed creator filter is a future enhancement; today we
      // require an address. The indexer's `userProfile` lookup happens
      // post-fetch so a full address-resolution path here would force a
      // second query path. Reject explicitly so callers don't silently
      // get an empty list.
      return {status: 400, body: {error: "creator must be a 0x address"}};
    }
    creatorFilter = lower as `0x${string}`;
  }

  const tickerFilter =
    params.ticker !== undefined && params.ticker.length > 0
      ? params.ticker.toUpperCase()
      : null;
  const nearMissOnly = params.nearMiss === "true" || params.nearMiss === "1";

  const sourceRows = await q.filteredTokens();
  // Decorate every row with computed fields BEFORE filtering — sort + filter
  // need access to derived `nearMissMarginHp` / `isNearMiss`.
  const allRows = sourceRows.map(decorateRow);

  // Filter set.
  let rows = allRows;
  if (seasonFilter !== null) {
    rows = rows.filter((r) => BigInt(r.season) === seasonFilter);
  }
  if (creatorFilter !== null) {
    rows = rows.filter((r) => r.creator.toLowerCase() === creatorFilter);
  }
  if (tickerFilter !== null) {
    // Substring match on the symbol. The wire `ticker` carries a leading `$`
    // which most callers don't include; match the underlying symbol instead.
    rows = rows.filter((r) =>
      r.ticker.toUpperCase().replace(/^\$/, "").includes(tickerFilter),
    );
  }
  if (nearMissOnly) {
    rows = rows.filter((r) => r.isNearMiss);
  }

  rows.sort(comparator(sort));

  const total = rows.length;
  const start = (page - 1) * perPage;
  const paged = rows.slice(start, start + perPage);

  // Decorate creator usernames + avatars from the identity layer, batched.
  const creatorAddrs = [...new Set(paged.map((r) => r.creator))];
  let profileMap: Map<string, CreatorProfileLookup>;
  try {
    profileMap = await q.creatorProfilesFor(creatorAddrs);
  } catch {
    // Identity layer is optional — degrade gracefully (no usernames). The
    // graveyard surface stays meaningful without identities.
    profileMap = new Map();
  }
  const enriched = paged.map((r) => {
    const profile = profileMap.get(r.creator.toLowerCase());
    return {
      ...r,
      creatorUsername: profile?.username ?? null,
      creatorAvatarUrl: profile?.avatarUrl ?? null,
    };
  });

  return {
    status: 200,
    body: {
      asOf: nowSec(),
      tokens: enriched,
      total,
      page,
      perPage,
    },
  };
}

/// Compute `nearMissMarginHp` + `isNearMiss` + decimal LP-returned + tradable
/// pill for a single source row. Pure; safe to invoke before sort/filter.
function decorateRow(r: GraveyardSourceRow): GraveyardTokenRow {
  // Margin convention (spec §36.3.3): `cutLineHp - finalHp` for FILTERED
  // tokens. A token finishing exactly AT the cut line has margin 0 (still
  // counts as a near-miss). A token whose finalHp landed above the cut line
  // shouldn't appear in this list (it survived); guard with max(0, …) so a
  // data anomaly produces a 0 margin rather than a negative.
  let nearMissMarginHp: number | null = null;
  let cutLineAnomaly = false;
  if (r.cutLineHp !== null) {
    const raw = r.cutLineHp - r.finalHp;
    nearMissMarginHp = raw >= 0 ? raw : 0;
    cutLineAnomaly = raw < 0;
  }
  // Bugbot PR #103 pass-4: a clamped-from-anomaly margin (raw < 0) shouldn't
  // be flagged as a near-miss — the row reflects a data inconsistency, not a
  // legitimately-close-to-the-cut filter event. Surface margin=0 (clamped)
  // for honesty but keep isNearMiss=false so the narrative flag isn't a false
  // positive.
  const isNearMiss =
    !cutLineAnomaly &&
    nearMissMarginHp !== null &&
    nearMissMarginHp <= NEAR_MISS_THRESHOLD_HP;

  return {
    address: r.address,
    ticker: tickerWithDollar(r.symbol),
    season: Number(r.seasonId),
    creator: r.creator,
    creatorUsername: null, // decorated post-paging
    creatorAvatarUrl: null,
    finalRank: r.finalRank,
    filterRound: r.filterRound,
    filteredAt: r.filteredAt === null ? null : Number(r.filteredAt),
    peakHp: r.peakHp,
    finalHp: r.finalHp,
    nearMissMarginHp,
    isNearMiss,
    holdersAtFilter: r.holdersAtFilter,
    lpReturnedWeth: weiToDecimalEther(r.liquidationProceeds ?? 0n),
    // Spec §36.1.2: filtered tokens stay tradable on their canonical V4 pool.
    // Always true at the contract level today; narrows once V4 reads stream
    // pool reserves.
    tradableNow: true,
  };
}

function parseSort(raw: string | undefined): GraveyardSort | null {
  if (raw === undefined) return "recent";
  switch (raw) {
    case "recent":
    case "season":
    case "rank":
    case "nearMissMargin":
    case "peakHp":
    case "creator":
      return raw;
    default:
      return null;
  }
}

function comparator(
  sort: GraveyardSort,
): (a: GraveyardTokenRow, b: GraveyardTokenRow) => number {
  switch (sort) {
    case "recent":
      // Most-recent filter first. Tokens with no filteredAt land at the bottom.
      return (a, b) => {
        const av = a.filteredAt ?? 0;
        const bv = b.filteredAt ?? 0;
        if (av !== bv) return bv - av;
        return a.address.localeCompare(b.address);
      };
    case "season":
      return (a, b) => {
        if (a.season !== b.season) return b.season - a.season;
        return a.address.localeCompare(b.address);
      };
    case "rank":
      // Lower rank = higher placement. Null ranks sort last.
      return (a, b) => {
        const ar = a.finalRank ?? Number.MAX_SAFE_INTEGER;
        const br = b.finalRank ?? Number.MAX_SAFE_INTEGER;
        if (ar !== br) return ar - br;
        return a.address.localeCompare(b.address);
      };
    case "nearMissMargin":
      // Smallest margin first (closest to cut line). Nulls sort last.
      return (a, b) => {
        const am = a.nearMissMarginHp ?? Number.MAX_SAFE_INTEGER;
        const bm = b.nearMissMarginHp ?? Number.MAX_SAFE_INTEGER;
        if (am !== bm) return am - bm;
        return a.address.localeCompare(b.address);
      };
    case "peakHp":
      return (a, b) => {
        if (a.peakHp !== b.peakHp) return b.peakHp - a.peakHp;
        return a.address.localeCompare(b.address);
      };
    case "creator":
      return (a, b) => {
        const cmp = a.creator.localeCompare(b.creator);
        if (cmp !== 0) return cmp;
        return b.season - a.season;
      };
  }
}

// ============================================================ /graveyard/:address

export interface GraveyardLifecycle {
  launchedAt: number;
  filteredAt: number | null;
  filterRound: "CUT" | "FINALIZE" | null;
  peakHp: number;
  peakHpAt: number | null;
  finalHp: number;
  finalRank: number | null;
  nearMissMarginHp: number | null;
  isNearMiss: boolean;
  holdersAtLaunch: number;
  holdersAtPeak: number;
  holdersAtFilter: number;
}

export interface GraveyardLpEvent {
  timestamp: number;
  kind: "MINT" | "BURN";
  amountWeth: string;
}

export interface GraveyardHpPoint {
  timestamp: number;
  hp: number;
}

export interface GraveyardHolderPoint {
  timestamp: number;
  holders: number;
}

export interface GraveyardSeasonSummary {
  id: number;
  startedAt: number;
  finalizedAt: number | null;
  winner: `0x${string}` | null;
}

export interface GraveyardTokenSummary {
  address: `0x${string}`;
  ticker: string;
  name: string;
  creator: `0x${string}`;
  creatorUsername: string | null;
  creatorAvatarUrl: string | null;
  isProtocolLaunched: boolean;
}

export interface GraveyardDetailResponse {
  token: GraveyardTokenSummary;
  season: GraveyardSeasonSummary;
  lifecycle: GraveyardLifecycle;
  hpTrajectory: GraveyardHpPoint[];
  lpEvents: GraveyardLpEvent[];
  holderTrajectory: GraveyardHolderPoint[];
  tradableNow: boolean;
}

/// Pure-handler shape for the per-token detail endpoint. The Drizzle adapter
/// fans out one query per field so each can be stubbed independently in tests.
export interface GraveyardDetailQueries {
  /// Token row + season for the address. Returns null when the address is
  /// unknown to the indexer.
  tokenAndSeason: (
    addr: `0x${string}`,
  ) => Promise<{
    token: {
      address: `0x${string}`;
      symbol: string;
      name: string;
      creator: `0x${string}`;
      seasonId: bigint;
      isProtocolLaunched: boolean;
      isFinalist: boolean;
      liquidated: boolean;
      createdAt: bigint;
    };
    season: {
      id: bigint;
      startedAt: bigint;
      finalizedAt: bigint | null;
      winner: `0x${string}` | null;
    };
  } | null>;
  /// Full HP snapshot series for the token, ordered by `snapshotAtSec`.
  hpSeriesForToken: (addr: `0x${string}`) => Promise<
    Array<{
      timestamp: bigint;
      hp: number;
      trigger: string;
    }>
  >;
  /// Holder-count series — one point per distinct snapshot timestamp where the
  /// indexer recorded a holderSnapshot for the token. Sparse; rendered as a
  /// step function client-side.
  holderSeriesForToken: (addr: `0x${string}`) => Promise<
    Array<{
      timestamp: bigint;
      holders: number;
    }>
  >;
  /// LP MINT/BURN events for the token's pool. Driven by FilterFactory + LP
  /// locker events. Today the indexer surfaces the BURN as the season's
  /// `liquidation` row; future work will fold MINT events from FilterFactory.
  lpEventsForToken: (addr: `0x${string}`) => Promise<
    Array<{
      timestamp: bigint;
      kind: "MINT" | "BURN";
      amountWeth: bigint;
    }>
  >;
  /// Cut line for the token's season — `min(hp)` over surviving CUT-tagged
  /// snapshots. Null pre-CUT.
  cutLineForSeason: (seasonId: bigint) => Promise<number | null>;
  /// Final cohort rank for the token. Null when the token wasn't scored at
  /// the trigger boundary.
  finalRankForToken: (addr: `0x${string}`) => Promise<number | null>;
  /// Single-creator profile lookup (Epic 1.24).
  creatorProfile: (addr: `0x${string}`) => Promise<CreatorProfileLookup | null>;
}

export async function getGraveyardDetailHandler(
  q: GraveyardDetailQueries,
  rawAddress: string,
): Promise<{status: number; body: GraveyardDetailResponse | {error: string}}> {
  const lower = rawAddress.toLowerCase();
  if (!isAddressLike(lower)) return {status: 400, body: {error: "invalid address"}};
  const addr = lower as `0x${string}`;

  const tas = await q.tokenAndSeason(addr);
  if (!tas) return {status: 404, body: {error: "unknown token"}};

  // Only filtered tokens belong in the graveyard surface. Active + finalist
  // tokens still in their season redirect to /tokens/:address (per the spec
  // graveyard intent — "preserves the full story of a FILTERED token").
  // A token that hasn't been liquidated yet returns 404 from this surface so
  // the spectator UI has a single answer for "this token isn't in the
  // graveyard yet."
  if (!tas.token.liquidated) {
    return {status: 404, body: {error: "token is not filtered"}};
  }

  const [hpRows, holderRows, lpRows, cutLineHp, finalRank, profile] = await Promise.all([
    q.hpSeriesForToken(addr),
    q.holderSeriesForToken(addr),
    q.lpEventsForToken(addr),
    q.cutLineForSeason(tas.token.seasonId),
    q.finalRankForToken(addr),
    q.creatorProfile(tas.token.creator),
  ]);

  // Resolve filter trigger row (CUT or FINALIZE) — the LATEST trigger-tagged
  // snapshot is what we use for finalHp + filteredAt.
  const triggerRow = pickFilterTriggerRow(hpRows);
  const finalHp = triggerRow?.hp ?? 0;
  const filterRound: "CUT" | "FINALIZE" | null =
    triggerRow?.trigger === "CUT" || triggerRow?.trigger === "FINALIZE"
      ? triggerRow.trigger
      : null;
  const filteredAtSec = triggerRow ? Number(triggerRow.timestamp) : null;

  // Peak HP = max across the full hp series. peakHpAt = the timestamp of the
  // first row that hit the peak (multiple ties → earliest, so spectators see
  // when the climb happened, not when it sustained).
  let peakHp = 0;
  let peakHpAt: number | null = null;
  for (const row of hpRows) {
    if (row.hp > peakHp) {
      peakHp = row.hp;
      peakHpAt = Number(row.timestamp);
    }
  }

  // Margin: cutLineHp - finalHp (clamped at 0). Null when no cut line yet.
  // Bugbot PR #103 pass-6: mirror decorateRow's `cutLineAnomaly` guard so
  // index and detail return identical isNearMiss for the same token. A
  // clamped-from-anomaly margin (raw < 0) is data inconsistency, not a real
  // close call — surface margin=0 for honesty but keep isNearMiss=false.
  let nearMissMarginHp: number | null = null;
  let cutLineAnomaly = false;
  if (cutLineHp !== null) {
    const raw = cutLineHp - finalHp;
    nearMissMarginHp = raw >= 0 ? raw : 0;
    cutLineAnomaly = raw < 0;
  }
  const isNearMiss =
    !cutLineAnomaly &&
    nearMissMarginHp !== null &&
    nearMissMarginHp <= NEAR_MISS_THRESHOLD_HP;

  // Holder counts at three lifecycle anchors: launch (0 by definition — no
  // ERC-20 transfers fired yet), peak (count at peakHpAt), and filter
  // (latest holder count BEFORE OR AT the filter timestamp). The series is
  // sparse; pick the closest preceding sample to each anchor.
  const holdersAtLaunch = 0;
  const holdersAtPeak = sampleHoldersAt(holderRows, peakHpAt);
  const holdersAtFilter = sampleHoldersAt(holderRows, filteredAtSec);

  return {
    status: 200,
    body: {
      token: {
        address: tas.token.address,
        ticker: tickerWithDollar(tas.token.symbol),
        name: tas.token.name,
        creator: tas.token.creator,
        creatorUsername: profile?.username ?? null,
        creatorAvatarUrl: profile?.avatarUrl ?? null,
        isProtocolLaunched: tas.token.isProtocolLaunched,
      },
      season: {
        id: Number(tas.season.id),
        startedAt: Number(tas.season.startedAt),
        finalizedAt: tas.season.finalizedAt === null ? null : Number(tas.season.finalizedAt),
        winner: tas.season.winner,
      },
      lifecycle: {
        launchedAt: Number(tas.token.createdAt),
        filteredAt: filteredAtSec,
        filterRound,
        peakHp,
        peakHpAt,
        finalHp,
        finalRank,
        nearMissMarginHp,
        isNearMiss,
        holdersAtLaunch,
        holdersAtPeak,
        holdersAtFilter,
      },
      hpTrajectory: hpRows.map((r) => ({
        timestamp: Number(r.timestamp),
        hp: r.hp,
      })),
      lpEvents: lpRows.map((r) => ({
        timestamp: Number(r.timestamp),
        kind: r.kind,
        amountWeth: weiToDecimalEther(r.amountWeth),
      })),
      holderTrajectory: holderRows.map((r) => ({
        timestamp: Number(r.timestamp),
        holders: r.holders,
      })),
      // Spec §36.1.2 — see graveyard.ts header. Always true today; narrows
      // when V4 reads stream pool reserves.
      tradableNow: true,
    },
  };
}

/// Pick the row that represents the filter trigger. CUT-tagged rows take
/// precedence over FINALIZE-tagged (a finals-week filter happens at FINALIZE,
/// but a token filtered at CUT also shows up in FINALIZE-tagged rows for the
/// post-cut spectator view; the CUT row is the authoritative one).
function pickFilterTriggerRow(
  rows: ReadonlyArray<{timestamp: bigint; hp: number; trigger: string}>,
): {timestamp: bigint; hp: number; trigger: string} | null {
  let cut: typeof rows[number] | null = null;
  let finalize: typeof rows[number] | null = null;
  for (const r of rows) {
    if (r.trigger === "CUT") {
      // Earliest CUT row wins — that's the actual filter moment.
      if (cut === null || r.timestamp < cut.timestamp) cut = r;
    } else if (r.trigger === "FINALIZE") {
      if (finalize === null || r.timestamp < finalize.timestamp) finalize = r;
    }
  }
  return cut ?? finalize;
}

/// Sample the holder series at `targetSec`, returning the holder count from
/// the most-recent row at-or-before that timestamp. Returns 0 when no row
/// precedes the target (or the series is empty).
function sampleHoldersAt(
  series: ReadonlyArray<{timestamp: bigint; holders: number}>,
  targetSec: number | null,
): number {
  if (targetSec === null) return 0;
  const target = BigInt(targetSec);
  let best = 0;
  let bestTs = -1n;
  for (const row of series) {
    if (row.timestamp <= target && row.timestamp > bestTs) {
      best = row.holders;
      bestTs = row.timestamp;
    }
  }
  return best;
}
