import {Scenario, type ScenarioDefinition} from "../index.js";
import {WETH, addressOf, walletRange} from "./_shared.js";

/// Wash-trade canonical (mirrors spec §27.6 case 1 — "whale buy does not
/// dominate" pattern, applied to a single wallet cycling buys + sells).
///
/// One wallet on `TEST_TOKEN` repeatedly buys then sells the same
/// position inside the 1h churn window. Scoring's net-velocity formula
/// nets the buy + sell to zero AND doubles the sell discount inside the
/// churn window — so the wash trader's velocity raw value collapses
/// despite its high gross volume.
///
/// `CONTROL_TOKEN` runs in parallel with healthy distributed buys (10
/// wallets each holding) so the cohort min-max normalization has signal.
/// The wash trader must lose to the control across velocity, effective
/// buyers (single wallet vs 10), and retention (no sustained holders).
export const washTradeScenario: ScenarioDefinition = {
  name: "wash-trade",
  description:
    "One wallet cycles buy/sell inside the churn window vs a control token with 10 honest distributed holders. Wash trader's HP must lose to control on velocity, effective buyers, and retention.",
  build({seed}) {
    const s = new Scenario({seed, startTs: 1_700_000_000n});
    const TEST_TOKEN = addressOf(0xa);
    const CONTROL_TOKEN = addressOf(0xb);
    const WASHER = addressOf(0x1001);
    const HONEST_WALLETS = walletRange(10, 0x2001);

    s.launch(CONTROL_TOKEN, 10n * WETH);
    s.launch(TEST_TOKEN, 10n * WETH);

    // Control: 10 wallets each buy 1 WETH, staggered every 60s, all hold.
    for (const w of HONEST_WALLETS) {
      s.buy(w, CONTROL_TOKEN, WETH);
      s.advance(60);
    }

    // Wash trader: 50 buy/sell cycles, 30s gap each side (well inside 1h
    // churn window). Cumulative buy volume balloons (50 WETH) but net
    // velocity stays at zero AND the churn-doubled sells push net negative.
    for (let i = 0; i < 50; i++) {
      s.buy(WASHER, TEST_TOKEN, WETH);
      s.advance(30);
      s.sell(WASHER, TEST_TOKEN, WETH);
      s.advance(30);
    }

    // Settle for an hour so retention anchors have meaningful data and
    // recent-LP-removed window clears.
    s.advance(3600);

    return {
      events: s.build(),
      assertions: [
        ({finalHP}) => {
          const test = finalHP.get(TEST_TOKEN.toLowerCase() as typeof TEST_TOKEN) ?? -1;
          const ctrl = finalHP.get(CONTROL_TOKEN.toLowerCase() as typeof CONTROL_TOKEN) ?? -1;
          return {
            description: "control HP outranks wash trader HP",
            passed: ctrl > test,
            detail: `control=${ctrl} wash=${test}`,
          };
        },
        ({timeseries}) => {
          // Velocity score for the wash trader at the final tick must be 0
          // (cohort min) — the churn-doubled sells bury its raw value
          // beneath the control's clean buy stream.
          const last = lastForToken(timeseries, TEST_TOKEN);
          const v = last?.components.velocity;
          return {
            description: "wash trader velocity component is at cohort min (0)",
            passed: v === 0,
            detail: `velocity=${v}`,
          };
        },
        ({finalHP}) => {
          // Sanity floor: wash trader's HP stays below 5000/10000 (Epic 1.18 int
          // scale; was 50/100) — no single wallet cycling its own buys should
          // put a token in the top half.
          const test = finalHP.get(TEST_TOKEN.toLowerCase() as typeof TEST_TOKEN) ?? -1;
          return {
            description: "wash trader HP < 5000",
            passed: test >= 0 && test < 5000,
            detail: `HP=${test}`,
          };
        },
      ],
    };
  },
};

function lastForToken(
  timeseries: ReadonlyArray<{tokenId: string; tick: number; components: {velocity: number}}>,
  token: string,
) {
  const lc = token.toLowerCase();
  for (let i = timeseries.length - 1; i >= 0; i--) {
    if (timeseries[i]!.tokenId === lc) return timeseries[i];
  }
  return undefined;
}
