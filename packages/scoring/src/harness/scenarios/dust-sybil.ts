import {Scenario, type ScenarioDefinition} from "../index.js";
import {WETH, addressOf, walletRange} from "./_shared.js";

/// Dust-sybil canonical (mirrors spec §27.6 case 2 — "many dust wallets
/// don't dominate HP").
///
/// 1000 wallets on `TEST_TOKEN` each buy a small amount just above the
/// effective-buyers dust floor (default 0.005 WETH, see scoring's
/// `DEFAULT_CONFIG.buyerDustFloorWeth`). Per-wallet sqrt-dampened
/// economic significance is small — `sqrt(0.01 WETH) ≈ 1e8` raw — even
/// summed across 1000 wallets the swarm's raw effective-buyers value
/// (~1e11) is in the same ballpark as the 30-wallet control's
/// `30 × sqrt(1 WETH) = 3e10`, so cohort min-max can place either at the
/// top of the single component. HP composition over five components is
/// what punishes the sybil pattern: per-wallet velocity is tiny (each
/// 0.01 WETH buy / log2(1+10)≈3.5 = ~0.003), and LP depth is thin
/// because no one's been adding liquidity.
///
/// The assertion mirrors §27.6: composition wins, sybil HP < control HP.
export const dustSybilScenario: ScenarioDefinition = {
  name: "dust-sybil",
  description:
    "1000 wallets each buy just above the dust floor on TEST vs 30 distributed 1-WETH buys on CONTROL. Sybil HP must lose to control under five-component composition.",
  build({seed}) {
    const s = new Scenario({seed, startTs: 1_700_000_000n});
    const TEST_TOKEN = addressOf(0xa);
    const CONTROL_TOKEN = addressOf(0xb);
    // 0.01 WETH — 2× the default dust floor, so wallets pass the filter
    // and land in the effective-buyers sum (where sqrt dampening must do
    // its job).
    const SYBIL_AMOUNT = 10n * 1_000_000_000_000_000n; // 0.01 WETH
    const SYBILS = walletRange(1000, 0x10000);
    const HONEST_WALLETS = walletRange(30, 0x2001);

    s.launch(CONTROL_TOKEN, 50n * WETH);
    // Sybil token has thin LP — the swarm wins headcount but loses depth.
    s.launch(TEST_TOKEN, 1n * WETH);

    // Control: 30 distributed honest buys, one per minute.
    for (const w of HONEST_WALLETS) {
      s.buy(w, CONTROL_TOKEN, WETH);
      s.advance(60);
    }

    // Sybil swarm — all buys land in a tight 5-min window so we don't
    // bloat the synthetic clock unnecessarily; the engine's velocity
    // time-decay only matters relative to the score tick, not within the
    // burst.
    for (let i = 0; i < SYBILS.length; i++) {
      s.buy(SYBILS[i]!, TEST_TOKEN, SYBIL_AMOUNT);
      // Tick every ~10 sybils so the burst spans 100 × 1s = 100s. Keeps
      // events sortable while not exploding the engine's per-tick work.
      if (i % 10 === 9) s.advance(1);
    }

    // Settle so retention anchors have data.
    s.advance(3600);

    return {
      events: s.build(),
      assertions: [
        ({finalHP}) => {
          const test = finalHP.get(TEST_TOKEN.toLowerCase() as typeof TEST_TOKEN) ?? -1;
          const ctrl = finalHP.get(CONTROL_TOKEN.toLowerCase() as typeof CONTROL_TOKEN) ?? -1;
          return {
            description: "control HP outranks dust-sybil HP",
            passed: ctrl > test,
            detail: `control=${ctrl} sybil=${test}`,
          };
        },
        ({timeseries}) => {
          // Sybil token must lose at least one of velocity / sticky-liq
          // — those are the components that resist breadth-only sybils.
          const last = lastForToken(timeseries, TEST_TOKEN);
          if (!last) return {description: "sybil token observed", passed: false, detail: "no record"};
          const v = last.components.velocity;
          const l = last.components.stickyLiquidity;
          return {
            description: "sybil token loses velocity OR sticky-liq to control",
            passed: v < 1 || l < 1,
            detail: `velocity=${v} stickyLiquidity=${l}`,
          };
        },
        ({finalHP}) => {
          // Epic 1.18: HP scale is integer [0, 10000]; 60 → 6000.
          const test = finalHP.get(TEST_TOKEN.toLowerCase() as typeof TEST_TOKEN) ?? -1;
          return {
            description: "sybil HP < 6000",
            passed: test >= 0 && test < 6000,
            detail: `HP=${test}`,
          };
        },
      ],
    };
  },
};

function lastForToken(
  timeseries: ReadonlyArray<{
    tokenId: string;
    tick: number;
    components: {velocity: number; stickyLiquidity: number};
  }>,
  token: string,
) {
  const lc = token.toLowerCase();
  for (let i = timeseries.length - 1; i >= 0; i--) {
    if (timeseries[i]!.tokenId === lc) return timeseries[i];
  }
  return undefined;
}
