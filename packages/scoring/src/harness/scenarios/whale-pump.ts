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
          // Per Epic 1.22 §6.7 fixed-reference normalization the cohort min
          // is no longer 0; it's `raw / EFFECTIVE_BUYERS_REFERENCE`. The
          // whale's eb_raw = sqrt(3) ≈ 1.73; the control's eb_raw =
          // 30 × sqrt(1) = 30. Both are positive but the whale's is far
          // smaller. Assert the WHALE row is strictly below the CONTROL
          // row instead of pinning to 0.
          const lastTest = lastForToken(timeseries, TEST_TOKEN);
          const lastCtrl = lastForToken(timeseries, CONTROL_TOKEN);
          const ebTest = lastTest?.components.effectiveBuyers ?? -1;
          const ebCtrl = lastCtrl?.components.effectiveBuyers ?? -1;
          return {
            description: "whale effective-buyers strictly below control's",
            passed: ebTest >= 0 && ebCtrl > ebTest,
            detail: `whale=${ebTest} control=${ebCtrl}`,
          };
        },
        ({finalHP}) => {
          // Sanity: whale HP stays moderate (< 5000 on int scale, was 50/100).
          // HP rewards conviction (1 holder fully retained = retention 1.0
          // × weight 0.10 = 1000 points on int10k) and a slice of momentum
          // (~500), so the floor is ~1500; 5000 is comfortably above any
          // mathematically achievable single-whale composite.
          const test = finalHP.get(TEST_TOKEN.toLowerCase() as typeof TEST_TOKEN) ?? -1;
          return {
            description: "whale HP < 5000",
            passed: test >= 0 && test < 5000,
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
