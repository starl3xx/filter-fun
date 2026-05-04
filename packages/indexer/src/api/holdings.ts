/// Pure handler for `GET /wallets/:address/holdings` — Epic 1.23.
///
/// Per-wallet holdings + projected rollover entitlement. Powers two surfaces:
///   - The Epic 1.11 admin console "creator's own holdings" panel (right column).
///   - The Epic 1.9 filter-moment recap card (replaces the `~Ξ ?` placeholder).
///
/// Single source of truth: both surfaces read from this endpoint, so the projected
/// number can never disagree across the admin console and the broadcast UX (the
/// cross-link test pins this).
///
/// The response lists every token the wallet currently holds (positive `holderBalance`)
/// with status flags + a projected rollover slice for tokens that have already been
/// filtered but where the season has not yet been finalized.
///
/// **Projection math** (spec §11 — losers-pot split). On every filter event the vault
/// liquidates each loser to WETH and applies a two-step split:
///
///   1. Skim 2.5% champion bounty off the top: `remainder = proceeds * 9750 / 10000`.
///   2. Slice 45% of `remainder` to the rollover reserve: `rolloverSlice = remainder * 4500 / 10000`.
///
/// (See `SeasonVault.processFilterEvent` for the canonical on-chain math.)
///
/// The rollover reserve is paid out at finalize via a Merkle tree whose leaves are
/// `(user, share)` pairs — shares are computed off-chain by the oracle from CUT-trigger
/// holderSnapshots (one per filter event, cumulative across the season). For the
/// projection here we approximate the same per-loser-token split using the indexer's
/// CUT-trigger snapshot of the token: `walletShare(token) = walletCutBalance / totalCutBalance`.
/// The wallet's projected entitlement from one filtered token is then
/// `walletShare(token) * rolloverSlice(token)` and the wallet's total projection is the
/// sum across all currently-filtered tokens it held at CUT.
///
/// **Why CUT-snapshot, not current balance?** Once a token is filtered its LP is
/// unwound and trading effectively stops; the canonical "you held it at the cut"
/// signal is the CUT-trigger holderSnapshot row written by the indexer at the moment
/// the first `Liquidated` event fires for the season. A wallet that bought the token
/// post-cut (e.g. zombie trade) would NOT receive a Merkle leaf, so reflecting their
/// current balance would over-project.
///
/// Returned `projectedRolloverWeth` is `null` when:
///   - The wallet does not appear in the token's CUT snapshot (sub-dust at cut, or
///     bought post-cut).
///   - The token isn't filtered (still active, finalist, or already won).
///   - The season is post-settlement (`season.winner != null` AND `winnerSettledAt != null`)
///     — at that point the on-chain Merkle has been published and the canonical claim
///     route is `/claim/rollover`, not the indexer projection.
///
/// `totalProjectedWeth` aggregates only the non-null per-token projections.
///
/// **Auth:** open. The endpoint is per-wallet self-service — every byte returned is
/// derivable from the existing public `/profile/:address` + on-chain balances. Rate-
/// limit shares the per-IP token bucket with the rest of the GET routes.

import {isAddressLike, tickerWithDollar, weiToDecimalEther} from "./builders.js";

/// One token the wallet currently holds. The `is*` flags + `projectedRolloverWeth`
/// are the wire-shape contract; clients render the badge string from the flag set.
export interface HoldingsTokenRow {
  address: `0x${string}`;
  ticker: string;
  season: number;
  /// Decimal-wei.
  balance: string;
  /// Decimal-ether — same formatting rule as `weiToDecimalEther` (≤6 decimals).
  balanceFormatted: string;
  isFiltered: boolean;
  isWinner: boolean;
  isFinalist: boolean;
  /// Decimal-wei or null (see header). Null means "no projection available" — UI
  /// renders "projection N/A" or "claim available" depending on which flag triggered
  /// the null.
  projectedRolloverWeth: string | null;
  /// Decimal-ether, mirrors `projectedRolloverWeth`. Null when the wei field is null.
  projectedRolloverWethFormatted: string | null;
  /// True when the season has been finalized + winner posted; the projection is
  /// suppressed in that case (claim has moved to the on-chain Merkle path) but the
  /// flag lets the UI render an appropriate "claim available" CTA.
  postSettlement: boolean;
}

export interface HoldingsResponse {
  wallet: `0x${string}`;
  /// Unix-seconds at which the response was computed. Matches the cache TTL anchor.
  asOf: number;
  tokens: HoldingsTokenRow[];
  /// Decimal-wei sum of every non-null `projectedRolloverWeth`.
  totalProjectedWeth: string;
  /// Decimal-ether equivalent of `totalProjectedWeth`.
  totalProjectedWethFormatted: string;
}

/// Token + season state for one position. Returned by the queries adapter so the
/// pure handler can compute flags + projection without touching Drizzle.
export interface HoldingTokenRow {
  token: `0x${string}`;
  symbol: string;
  seasonId: bigint;
  liquidated: boolean;
  isFinalist: boolean;
  liquidationProceeds: bigint | null;
  /// Wallet's current ERC-20 balance for this token, in wei.
  balance: bigint;
  /// `season.winner` for the same `seasonId` — null when the season hasn't been finalized.
  seasonWinner: `0x${string}` | null;
  /// `season.winnerSettledAt` — non-null once `submitWinner` lands. Used to flag the
  /// post-settlement state where the projection is suppressed in favour of the
  /// on-chain Merkle claim path.
  winnerSettledAt: bigint | null;
}

/// Per-token CUT-snapshot aggregates for the projection math. The tuple is
/// `(walletBalance, totalBalance)` — `walletBalance == 0n` means the wallet was
/// sub-dust at CUT (no Merkle leaf will be issued); `totalBalance == 0n` is a
/// defensive guard for tokens that were filtered with no surviving holders.
export interface CutSnapshotForToken {
  walletCutBalance: bigint;
  totalCutBalance: bigint;
}

export interface HoldingsQueries {
  /// Tokens for which `holderBalance.holder = wallet AND balance > 0`. Joined to
  /// `token` + `season` so the handler has every flag it needs.
  holdingsForUser: (wallet: `0x${string}`) => Promise<HoldingTokenRow[]>;
  /// CUT-trigger holderSnapshot aggregates for `(token, wallet)`. Returns
  /// `null` when no CUT-trigger row exists for the token (filtered before
  /// indexing started, or the indexer hasn't ingested the cut yet).
  cutSnapshotForToken: (
    token: `0x${string}`,
    wallet: `0x${string}`,
  ) => Promise<CutSnapshotForToken | null>;
}

/// Bps constants — locked at 250 (2.5% bounty) and 4500 (45% rollover) by the
/// SeasonVault contract. Mirroring them here makes the projection math auditable
/// without a contract read; the integration test pins parity against
/// `SeasonVault.BOUNTY_BPS` / `ROLLOVER_BPS`.
const BPS_DENOMINATOR = 10_000n;
const BOUNTY_BPS = 250n;
const ROLLOVER_BPS = 4500n;

/// Compute the rollover slice for one filtered token's liquidation proceeds.
/// Mirrors `SeasonVault.processFilterEvent`:
///   bountySlice = proceeds * BOUNTY_BPS / BPS_DENOMINATOR
///   remainder   = proceeds - bountySlice
///   rollover    = remainder * ROLLOVER_BPS / BPS_DENOMINATOR
export function rolloverSliceFromProceeds(proceeds: bigint): bigint {
  if (proceeds <= 0n) return 0n;
  const bountySlice = (proceeds * BOUNTY_BPS) / BPS_DENOMINATOR;
  const remainder = proceeds - bountySlice;
  return (remainder * ROLLOVER_BPS) / BPS_DENOMINATOR;
}

export async function getHoldingsHandler(
  q: HoldingsQueries,
  rawAddress: string,
  /// Caller-injected clock so tests can pin `asOf`. Route passes
  /// `() => Math.floor(Date.now() / 1000)`.
  nowSec: () => number,
): Promise<{status: number; body: HoldingsResponse | {error: string}}> {
  const lower = rawAddress.toLowerCase();
  if (!isAddressLike(lower)) return {status: 400, body: {error: "invalid address"}};
  const wallet = lower as `0x${string}`;

  const positions = await q.holdingsForUser(wallet);

  // Per-token CUT snapshot lookups run only for tokens that are actually filtered
  // AND not yet post-settlement — projecting for any other state is a no-op, so we
  // skip the query.
  const filteredCandidates = positions.filter((p) => p.liquidated && p.winnerSettledAt === null);
  const cutLookups = await Promise.all(
    filteredCandidates.map((p) => q.cutSnapshotForToken(p.token, wallet)),
  );
  const cutByToken = new Map<string, CutSnapshotForToken | null>();
  filteredCandidates.forEach((p, i) => {
    cutByToken.set(p.token.toLowerCase(), cutLookups[i] ?? null);
  });

  let totalProjectedWei = 0n;
  const tokens: HoldingsTokenRow[] = positions.map((p) => {
    const isWinner =
      p.seasonWinner !== null && p.seasonWinner.toLowerCase() === p.token.toLowerCase();
    const postSettlement = p.winnerSettledAt !== null;

    let projectedWei: bigint | null = null;
    if (p.liquidated && !postSettlement) {
      const cut = cutByToken.get(p.token.toLowerCase()) ?? null;
      const proceeds = p.liquidationProceeds ?? 0n;
      if (cut && cut.totalCutBalance > 0n && cut.walletCutBalance > 0n && proceeds > 0n) {
        const slice = rolloverSliceFromProceeds(proceeds);
        // Pro-rata in wei. Order chosen to keep the multiplicand large before the
        // divide so we don't lose resolution on small balances.
        projectedWei = (slice * cut.walletCutBalance) / cut.totalCutBalance;
      } else {
        // No CUT row for the wallet (sub-dust at cut, or the cut hasn't indexed yet)
        // → no projection, but the row still surfaces with `isFiltered: true` so
        // the UI can render an honest "no entitlement" rather than hide the holding.
        projectedWei = null;
      }
    }

    if (projectedWei !== null) totalProjectedWei += projectedWei;

    return {
      address: p.token,
      ticker: tickerWithDollar(p.symbol),
      season: Number(p.seasonId),
      balance: p.balance.toString(),
      balanceFormatted: weiToDecimalEther(p.balance),
      isFiltered: p.liquidated,
      isWinner,
      isFinalist: p.isFinalist,
      projectedRolloverWeth: projectedWei !== null ? projectedWei.toString() : null,
      projectedRolloverWethFormatted: projectedWei !== null ? weiToDecimalEther(projectedWei) : null,
      postSettlement,
    };
  });

  return {
    status: 200,
    body: {
      wallet,
      asOf: nowSec(),
      tokens,
      totalProjectedWeth: totalProjectedWei.toString(),
      totalProjectedWethFormatted: weiToDecimalEther(totalProjectedWei),
    },
  };
}
