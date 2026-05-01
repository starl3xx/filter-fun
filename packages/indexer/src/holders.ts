/// Shared constants for holder-snapshot logic. Lives in its own module so the
/// dust threshold can't drift between the writer (`SeasonVault.ts`) and any reader
/// that wants to apply the same filter (e.g. /profile.stats.filtersSurvived).

/// Minimum balance (in token wei) for a holder to count as "holding" a token at
/// a snapshot anchor. The default 10^14 (`0.0001` of an 18-decimal token) keeps
/// dust airdrops + sub-cent residuals out of the holder set without excluding any
/// realistic small holder. Override via env on the indexer process if needed.
export const DUST_BALANCE_THRESHOLD: bigint = (() => {
  const raw = process.env.HOLDER_SNAPSHOT_DUST_WEI;
  if (!raw) return 100_000_000_000_000n; // 1e14 wei
  try {
    return BigInt(raw);
  } catch {
    console.warn(
      `[holders] HOLDER_SNAPSHOT_DUST_WEI=${raw} is not a valid bigint; falling back to default 1e14`,
    );
    return 100_000_000_000_000n;
  }
})();
