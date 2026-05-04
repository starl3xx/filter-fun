/// Pure handler for `GET /tokens/:address/component-deltas` — Epic 1.23.
///
/// Returns the last N swap-driven HP-component deltas for one token, grouped by
/// component. Powers the admin console v2 HP-component drilldown (the
/// expandable section under each mini-bar). The dispatch lists it as a wiring
/// surface against `/tokens/:address/history`, but `HistoryPoint` deliberately
/// omits the swap-side metadata (taker / txHash / wethValue) — the drilldown's
/// example UX needs all three to render the per-row line:
///
///   +0.42 velocity · 0.5 ETH buy by 0xabc...123 · 14m ago · [tx]
///
/// Surfacing this here keeps the wire-shape extension OUT of the existing
/// history endpoint (cleaner cache key story, no consumer-side migration) and
/// scoped to the one consumer that actually needs it.
///
/// Wire shape:
///   {
///     "token": "0x...",
///     "computedAt": 1730000000,
///     "threshold": 0.05,
///     "components": {
///       "velocity":        [{timestamp, delta, swap}, ...],
///       "effectiveBuyers": [...],
///       "stickyLiquidity": [...],
///       "retention":       [...],
///       "momentum":        [...]
///     }
///   }
///
/// Each component array carries up to `limit` rows, sorted newest-first.
/// `delta` is the component score change vs the immediately-preceding HP
/// snapshot, in raw [-1, 1] space. The handler filters to rows where
/// |delta| >= threshold (default 0.05) so noisy near-zero shifts don't
/// crowd out the signal.

import {isAddressLike} from "./builders.js";

export interface SwapImpactRow {
  /// HP-snapshot timestamp (unix-seconds).
  timestamp: number;
  /// Per-component score delta vs the previous snapshot. Range [-1, 1] —
  /// only rows with |delta| >= threshold are surfaced.
  delta: number;
  /// Joined swap context. `null` when the snapshot fired without a paired
  /// swap row in the same block (e.g. trigger=SWAP but the index lookup
  /// raced ahead — surfaced as null so the wire shape stays uniform).
  swap: SwapContext | null;
}

export interface SwapContext {
  side: "BUY" | "SELL";
  /// Wallet that initiated the swap. Lower-cased.
  taker: `0x${string}`;
  /// Decimal-wei (absolute WETH leg of the swap).
  wethValue: string;
  /// Transaction hash, lower-cased. Linkable on Basescan.
  txHash: `0x${string}`;
}

export type ComponentKey =
  | "velocity"
  | "effectiveBuyers"
  | "stickyLiquidity"
  | "retention"
  | "momentum";

export const COMPONENT_KEYS: ReadonlyArray<ComponentKey> = [
  "velocity",
  "effectiveBuyers",
  "stickyLiquidity",
  "retention",
  "momentum",
];

export interface ComponentDeltasResponse {
  token: `0x${string}`;
  computedAt: number;
  threshold: number;
  components: Record<ComponentKey, SwapImpactRow[]>;
}

/// One trigger=SWAP HP snapshot, plus the snapshot immediately before it
/// (so deltas can be computed). The queries adapter is responsible for
/// returning rows ordered by `timestamp` ascending.
export interface SnapshotRow {
  token: `0x${string}`;
  timestamp: number;
  trigger: string;
  blockNumber: bigint;
  velocity: number;
  effectiveBuyers: number;
  stickyLiquidity: number;
  retention: number;
  momentum: number;
}

export interface SwapJoinRow {
  txHash: `0x${string}`;
  taker: `0x${string}`;
  side: "BUY" | "SELL";
  wethValue: bigint;
  blockNumber: bigint;
  blockTimestamp: bigint;
}

export interface ComponentDeltasQueries {
  /// Recent HP snapshots for `token`, newest-first, capped at the most recent
  /// `windowSize` rows. The handler walks the array in time order to compute
  /// deltas; trimming is the queries-side concern.
  recentSnapshots: (token: `0x${string}`, windowSize: number) => Promise<SnapshotRow[]>;
  /// Swaps for `token` that happened in any block listed in `blockNumbers`.
  /// Used to attach swap context to trigger=SWAP HP snapshots.
  swapsForBlocks: (
    token: `0x${string}`,
    blockNumbers: ReadonlyArray<bigint>,
  ) => Promise<SwapJoinRow[]>;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_THRESHOLD = 0.05;
const MAX_LIMIT = 50;
/// Window of snapshots to scan when looking for the last N material deltas.
/// Picked empirically from the Sepolia traffic pattern (~30 SWAP-trigger
/// snapshots/h on a hot token); 200 buys ~6h of history at peak. Bumped here
/// is cheap (linear scan); bumped at request time would force the queries
/// adapter to widen the per-request DB scan.
const SNAPSHOT_WINDOW_SIZE = 200;

export interface ComponentDeltasOpts {
  nowSec: () => number;
}

export interface ComponentDeltasParams {
  limit?: string;
  threshold?: string;
}

export async function getComponentDeltasHandler(
  q: ComponentDeltasQueries,
  rawAddress: string,
  params: ComponentDeltasParams,
  opts: ComponentDeltasOpts,
): Promise<{status: number; body: ComponentDeltasResponse | {error: string}}> {
  const lower = rawAddress.toLowerCase();
  if (!isAddressLike(lower)) return {status: 400, body: {error: "invalid address"}};

  const limit = parseLimit(params.limit);
  if (limit === null) {
    return {
      status: 400,
      body: {error: `limit must be a positive integer ≤ ${MAX_LIMIT}`},
    };
  }
  const threshold = parseThreshold(params.threshold);
  if (threshold === null) {
    return {status: 400, body: {error: "threshold must be a number in [0, 1]"}};
  }

  const tokenAddr = lower as `0x${string}`;
  const snapshots = await q.recentSnapshots(tokenAddr, SNAPSHOT_WINDOW_SIZE);

  // Sort ascending so deltas can be walked from oldest → newest.
  const ordered = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);

  // Pull all SWAP-trigger block numbers in one batch so the swap join is
  // a single round-trip instead of N per-row reads.
  const swapBlockNumbers: bigint[] = [];
  for (const s of ordered) {
    if (s.trigger === "SWAP") swapBlockNumbers.push(s.blockNumber);
  }
  const swaps = swapBlockNumbers.length > 0 ? await q.swapsForBlocks(tokenAddr, swapBlockNumbers) : [];
  const swapByBlock = new Map<bigint, SwapJoinRow>();
  for (const sw of swaps) {
    // Multiple swaps in the same block fall back to the highest-WETH leg as
    // the "dominant" representative for the row. The HP snapshot's value
    // already reflects the cumulative effect of every swap in the block, so
    // collapsing to one representative for display purposes is honest enough.
    const existing = swapByBlock.get(sw.blockNumber);
    if (!existing || sw.wethValue > existing.wethValue) {
      swapByBlock.set(sw.blockNumber, sw);
    }
  }

  // Walk pairs (prev, curr) and accumulate per-component impact rows for any
  // SWAP-trigger snapshot whose component delta crosses the threshold.
  const acc: Record<ComponentKey, SwapImpactRow[]> = {
    velocity: [],
    effectiveBuyers: [],
    stickyLiquidity: [],
    retention: [],
    momentum: [],
  };

  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const curr = ordered[i]!;
    if (curr.trigger !== "SWAP") continue;
    const swap = swapByBlock.get(curr.blockNumber) ?? null;

    for (const k of COMPONENT_KEYS) {
      const delta = curr[k] - prev[k];
      if (Math.abs(delta) < threshold) continue;
      acc[k].push({
        timestamp: curr.timestamp,
        delta,
        swap: swap
          ? {
              side: swap.side,
              taker: swap.taker.toLowerCase() as `0x${string}`,
              wethValue: swap.wethValue.toString(),
              txHash: swap.txHash.toLowerCase() as `0x${string}`,
            }
          : null,
      });
    }
  }

  // Cap each component at `limit`, newest-first.
  const components: Record<ComponentKey, SwapImpactRow[]> = {
    velocity:        acc.velocity.slice(-limit).reverse(),
    effectiveBuyers: acc.effectiveBuyers.slice(-limit).reverse(),
    stickyLiquidity: acc.stickyLiquidity.slice(-limit).reverse(),
    retention:       acc.retention.slice(-limit).reverse(),
    momentum:        acc.momentum.slice(-limit).reverse(),
  };

  return {
    status: 200,
    body: {
      token: tokenAddr,
      computedAt: opts.nowSec(),
      threshold,
      components,
    },
  };
}

// ============================================================ helpers (exported for tests)

export function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_LIMIT) return null;
  return n;
}

export function parseThreshold(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_THRESHOLD;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}
