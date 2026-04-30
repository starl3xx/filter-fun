import {Scenario, type ScenarioDefinition} from "../index.js";
import {WETH, addressOf, walletRange} from "./_shared.js";

/// Whale-pump canonical (mirrors spec §27.6 case 1 — "a single whale buy
/// does not dominate HP alone").
///
/// One wallet on `TEST_TOKEN` places a single 3 WETH buy (≈$10k at typical
/// ETH price — the spec's whale-test scale). No other activity. Scoring's
/// per-wallet velocity log-cap caps the whale's contribution well below
/// the cumulative net of 30 distributed buyers, and the effective-buyers
/// component (sqrt-dampened, spec §6.4.2) places a single wallet at
/// cohort min when normalized against a 30-wallet control.
///
/// `CONTROL_TOKEN` runs 30 honest distributed buys at 1 WETH each so the
/// cohort comparison is meaningful.
export const whalePumpScenario: ScenarioDefinition = {
  name: "whale-pump",
  description:
    "One wallet places a single 3 WETH buy on TEST vs a control with 30 distributed 1-WETH buys. Whale must lose velocity, effective-buyers, and overall HP.",
  build({seed}) {
    const s = new Scenario({seed, startTs: 1_700_000_000n});
    const TEST_TOKEN = addressOf(0xa);
    const CONTROL_TOKEN = addressOf(0xb);
    const WHALE = addressOf(0x1001);
    const HONEST_WALLETS = walletRange(30, 0x2001);

    s.launch(CONTROL_TOKEN, 50n * WETH);
    s.launch(TEST_TOKEN, 50n * WETH);

    // Control: 30 distributed honest buys staggered every 60s.
    for (const w of HONEST_WALLETS) {
      s.buy(w, CONTROL_TOKEN, WETH);
      s.advance(60);
    }

    // Whale: a single 3 WETH buy at the very end (≈$10k), then dead air.
    // The whale holds (no sells), so retention stays at 1.0 — but that's
    // the only component working in its favor; velocity, effective buyers,
    // and sticky liq all favor the broad-participation control.
    s.buy(WHALE, TEST_TOKEN, 3n * WETH);

    // Let retention anchors saturate.
    s.advance(3600);

    return {
      events: s.build(),
      assertions: [
        ({finalHP}) => {
          const test = finalHP.get(TEST_TOKEN.toLowerCase() as typeof TEST_TOKEN) ?? -1;
          const ctrl = finalHP.get(CONTROL_TOKEN.toLowerCase() as typeof CONTROL_TOKEN) ?? -1;
          return {
            description: "control HP outranks whale-pump HP",
            passed: ctrl > test,
            detail: `control=${ctrl} whale=${test}`,
          };
        },
        ({timeseries}) => {
          // Whale's effective-buyers component sits at cohort min (0) —
          // sqrt(100 WETH) is large in absolute terms but a single wallet
          // can't beat 30 wallets' summed sqrt under min-max.
          const last = lastForToken(timeseries, TEST_TOKEN);
          const eb = last?.components.effectiveBuyers;
          return {
            description: "whale effective-buyers component is at cohort min (0)",
            passed: eb === 0,
            detail: `effectiveBuyers=${eb}`,
          };
        },
        ({finalHP}) => {
          // Sanity: whale HP stays moderate (< 50). HP rewards conviction
          // (1 holder fully retained = retention 1.0 × weight 0.10 = 10
          // points) and a slice of momentum (~5 points), so the floor is
          // ~15; 50 is comfortably above any mathematically achievable
          // single-whale composite.
          const test = finalHP.get(TEST_TOKEN.toLowerCase() as typeof TEST_TOKEN) ?? -1;
          return {
            description: "whale HP < 50",
            passed: test >= 0 && test < 50,
            detail: `HP=${test}`,
          };
        },
      ],
    };
  },
};

function lastForToken(
  timeseries: ReadonlyArray<{tokenId: string; tick: number; components: {effectiveBuyers: number}}>,
  token: string,
) {
  const lc = token.toLowerCase();
  for (let i = timeseries.length - 1; i >= 0; i--) {
    if (timeseries[i]!.tokenId === lc) return timeseries[i];
  }
  return undefined;
}
