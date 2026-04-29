"use client";

import {useEffect, useState} from "react";

/// POL accounting surfaced to the broadcast UI. Mirrors the on-chain `SeasonVault`'s
/// `polReserveBalance()` view + the post-settlement `polDeployedWeth` / `polDeployedTokens`,
/// plus a synthetic "projected backing" the indexer derives by summing up future projected
/// liquidations × the POL_BPS slice (10%).
///
/// During the week: `polReserve` grows as filter events fire; `finalPOLDeployed` is 0.
/// After final settlement: `polReserve` drops to 0; `finalPOLDeployed` reflects what was
/// actually swapped into the winner.
export interface POLStats {
  /// Live WETH balance held by `SeasonPOLReserve` (this season).
  polReserve: number;
  /// Indexer-projected backing if all current loser-tokens were filtered today. Includes
  /// the live reserve PLUS the 10% slice of projected unwind value across non-finalist
  /// tokens — so the broadcast UI can preview "the winner will get ~$X backing".
  projectedWinnerBacking: number;
  /// Realized POL deployed at the most recent settlement. 0 mid-week.
  finalPOLDeployed: number;
  /// True while the values are simulated/preview — not from the indexer. The panel uses
  /// this to render a "PREVIEW" badge so users never mistake fake numbers for real
  /// on-chain state.
  isPreview: boolean;
}

const ZERO_STATS: POLStats = {
  polReserve: 0,
  projectedWinnerBacking: 0,
  finalPOLDeployed: 0,
  isPreview: false,
};

/// Reads POL stats. Default behavior: returns honest zeros (no indexer wired yet, so
/// nothing to read). When `NEXT_PUBLIC_DEMO_MODE === "1"` the hook runs the
/// design-preview simulation that animates the panel for screenshots and demo deploys —
/// in that mode `isPreview: true` is set so the panel can mark the values as fake.
///
/// Production swap-in: replace the demo branch with a GraphQL/websocket subscription to
/// the indexer and emit the same `POLStats` shape with `isPreview: false`.
export function usePOLStats(): POLStats {
  const [stats, setStats] = useState<POLStats>(ZERO_STATS);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_DEMO_MODE !== "1") return;

    // Tick at ~2s. Reserve climbs from 0 → ~80 WETH over a simulated week, then settles.
    let elapsedSec = 0;
    const id = setInterval(() => {
      elapsedSec += 2;
      const weekSec = 7 * 24 * 3600;
      const cycle = elapsedSec % (weekSec + 60); // settle bursts to bring it visible
      if (cycle < weekSec) {
        // Accumulation phase. Sub-linear so it has the "fat at the start, slowing" feel of
        // real cuts (more activity early as users churn, less as the field thins).
        const progress = cycle / weekSec;
        const polReserve = 80 * Math.sqrt(progress);
        const projectedWinnerBacking = polReserve * 1.4 + 18;
        setStats({polReserve, projectedWinnerBacking, finalPOLDeployed: 0, isPreview: true});
      } else {
        // Settlement burst — show finalPOLDeployed, drain reserve.
        setStats((prev) => ({
          polReserve: 0,
          projectedWinnerBacking: 0,
          finalPOLDeployed: prev.polReserve > 0 ? prev.polReserve : 80,
          isPreview: true,
        }));
      }
    }, 2000);
    return () => clearInterval(id);
  }, []);

  return stats;
}
