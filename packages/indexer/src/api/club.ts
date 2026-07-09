/// Pure handler for `GET /club` — Epic 2.6 / spec §47.3.8.
///
/// One payload serves both consumers:
///   - the public mint page (`/club` in the web app): supply progress, price,
///     sold-out state, holder roster for social proof;
///   - the operator FilterClubCard (spec §47.3.8): proceeds accounting
///     (audit-budget allocation), credit issued/consumed/outstanding/reclaimed,
///     recent redemptions.
///
/// The data is public chain state, so the endpoint is NOT operator-gated —
/// keeping it on the public surface lets the mint page share it. Per the
/// endpoint-status contract (README "Audit H-2"), the route always answers 200
/// with a well-formed body; pre-deploy (no pass configured / no rows yet) it
/// returns the zero-state rather than a 404, so the web can render a skeleton
/// without special-casing.
///
/// Wei values serialize as decimal strings (`weiToDecimalEther` is NOT used
/// here — the mint page multiplies price × qty in bigint, so it wants exact
/// wei, matching the `/wallets/:address/holdings` convention).

export interface ClubHolderRow {
  address: `0x${string}`;
  tokenIds: number[];
  creditsRemaining: number;
}

export interface ClubRedemptionRow {
  seasonId: number;
  creator: `0x${string}`;
  tokenId: number;
  status: "CONSUMED" | "RECLAIMED";
  consumedAt: number;
  reclaimedAt: number | null;
}

export interface ClubResponse {
  /// Passes minted so far (monotonic; no burn path).
  minted: number;
  /// Hard supply ceiling from the manifest config (genesis: 250). Zero when the
  /// pass isn't configured yet — consumers treat that as "mint not live".
  maxSupply: number;
  /// Fixed mint price in wei (decimal string; genesis: 0.05 ether).
  mintPriceWei: string;
  /// Sum of `pricePaid` across all mints, in wei (decimal string). The operator
  /// card renders this against the 12.5 ETH audit-budget target.
  proceedsWei: string;
  credits: {
    /// minted × CREDITS_PER_TOKEN.
    issued: number;
    consumed: number;
    reclaimed: number;
    /// issued − consumed + reclaimed — credits still spendable across all passes.
    outstanding: number;
  };
  holders: ClubHolderRow[];
  /// Most recent first, capped at 20 — the operator card's activity list.
  recentRedemptions: ClubRedemptionRow[];
}

/// Mirrors `FilterClubPass.CREDITS_PER_TOKEN` (immutable on-chain constant).
export const CLUB_CREDITS_PER_TOKEN = 2;

export interface ClubPassSourceRow {
  id: bigint;
  owner: `0x${string}`;
  creditsRemaining: number;
}

export interface ClubStatsSourceRow {
  minted: number;
  proceedsWei: bigint;
  creditsConsumed: number;
  creditsReclaimed: number;
}

export interface ClubRedemptionSourceRow {
  seasonId: bigint;
  creator: `0x${string}`;
  tokenId: bigint;
  status: string;
  consumedAt: bigint;
  reclaimedAt: bigint | null;
}

export interface ClubQueries {
  stats(): Promise<ClubStatsSourceRow | null>;
  passes(): Promise<ClubPassSourceRow[]>;
  recentRedemptions(limit: number): Promise<ClubRedemptionSourceRow[]>;
}

export interface ClubConfig {
  /// From manifest `config.filterClubMaxSupply`; 0 when unset (pre-club manifest).
  maxSupply: number;
  /// From manifest `config.filterClubMintPriceWei`; "0" when unset.
  mintPriceWei: string;
}

export async function getClubHandler(
  queries: ClubQueries,
  config: ClubConfig,
): Promise<{status: 200; body: ClubResponse}> {
  const [stats, passes, redemptions] = await Promise.all([
    queries.stats(),
    queries.passes(),
    queries.recentRedemptions(20),
  ]);

  // Roster grouped by current owner. Bounded by maxSupply (250 at genesis), so
  // an unpaginated roster is fine — revisit if supply ever grows.
  const byOwner = new Map<`0x${string}`, ClubHolderRow>();
  for (const p of passes) {
    const row = byOwner.get(p.owner) ?? {address: p.owner, tokenIds: [], creditsRemaining: 0};
    row.tokenIds.push(Number(p.id));
    row.creditsRemaining += p.creditsRemaining;
    byOwner.set(p.owner, row);
  }
  const holders = [...byOwner.values()].sort(
    (a, b) => b.creditsRemaining - a.creditsRemaining || a.address.localeCompare(b.address),
  );
  for (const h of holders) h.tokenIds.sort((a, b) => a - b);

  const minted = stats?.minted ?? 0;
  const consumed = stats?.creditsConsumed ?? 0;
  const reclaimed = stats?.creditsReclaimed ?? 0;
  const issued = minted * CLUB_CREDITS_PER_TOKEN;

  return {
    status: 200,
    body: {
      minted,
      maxSupply: config.maxSupply,
      mintPriceWei: config.mintPriceWei,
      proceedsWei: (stats?.proceedsWei ?? 0n).toString(),
      credits: {
        issued,
        consumed,
        reclaimed,
        outstanding: issued - consumed + reclaimed,
      },
      holders,
      recentRedemptions: redemptions.map((r) => ({
        seasonId: Number(r.seasonId),
        creator: r.creator,
        tokenId: Number(r.tokenId),
        status: r.status === "RECLAIMED" ? "RECLAIMED" : "CONSUMED",
        consumedAt: Number(r.consumedAt),
        reclaimedAt: r.reclaimedAt === null ? null : Number(r.reclaimedAt),
      })),
    },
  };
}
