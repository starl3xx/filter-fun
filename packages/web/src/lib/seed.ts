// Seed data + simulation templates. Replace with real indexer/websocket data
// when wired; the live-data hooks read these as starting state.

import {COMPONENT_LABELS, PRE_FILTER_WEIGHTS, type ScoredToken} from "@filter-fun/scoring";

export type TokenStatus = "finalist" | "safe" | "risk";

// Mirror the live ScoredToken shape so the live-data path slots in directly.
export type HpComponents = ScoredToken["components"];

// Relative emphasis per component: [velocity, effectiveBuyers, stickyLiquidity,
// retention, momentum]. Multiplied by the token's overall HP to derive each
// component's normalized score, then clamped — so a token with mix [1.4, 0.6,
// 0.4, 0.2, 0.5] has a "pump-and-dump" tooltip profile (high buying activity,
// dead retention) versus a balanced [1, 1, 1, 1, 1] contender.
export type ComponentMix = [number, number, number, number, number];

export type Token = {
  ticker: string;
  name: string;
  tag: "protocol" | null;
  score: number;
  price: number;
  // Total supply in token units. Different per token (some are 1B, some 100B,
  // some 1T) — exactly what makes price-comparison meaningless across the
  // cohort and mcap the right column to show.
  supply: number;
  // Derived: price * supply. Recomputed on each tick alongside price.
  mcap: number;
  ch: number;
  holders: number;
  liq: number;
  status: TokenStatus;
  spark: number[];
  rank: number;
  // Per-component HP breakdown (matches the live scoring engine's shape so the
  // tooltip works with real data later). Each component carries score [0,1],
  // weight, and the UI label.
  components: HpComponents;
};

// Seeds are spread across 1B / 100B / 1T supplies so the simulated cohort has
// the same "high HP, low mcap" tension the real game will have — RUG and DUST
// have low scores AND small mcaps, but MOON has a massive supply with a small
// price, putting its mcap in the middle of the pack despite being mid-rank.
//
// `mix` shapes the per-component HP profile shown in the leaderboard tooltip:
// e.g. RUG looks like a pump-and-dump (high velocity, near-zero retention),
// KING reads like conviction (sticky-liq + retention dominate), etc.
export type SeedToken = Omit<Token, "spark" | "rank" | "mcap" | "components"> & {
  mix: ComponentMix;
};

export const SEED_TOKENS: SeedToken[] = [
  {ticker: "FILTER", name: "Filter", tag: "protocol", score: 9420, price: 0.428, supply: 1_000_000_000, ch: 12.4, holders: 8421, liq: 1840000, status: "finalist", mix: [1.05, 1.05, 1.05, 1.0, 1.0]},
  {ticker: "BLOOD", name: "Bloodline", tag: null, score: 9180, price: 0.0091, supply: 100_000_000_000, ch: 38.2, holders: 5104, liq: 412000, status: "finalist", mix: [1.3, 1.2, 0.85, 0.85, 1.4]},
  {ticker: "KING", name: "Kingmaker", tag: null, score: 8720, price: 1.84, supply: 50_000_000, ch: 6.9, holders: 3982, liq: 980000, status: "safe", mix: [0.85, 0.7, 1.4, 1.4, 0.7]},
  {ticker: "SURVIVE", name: "Survive", tag: null, score: 8410, price: 0.214, supply: 1_000_000_000, ch: 4.1, holders: 2841, liq: 312000, status: "safe", mix: [0.95, 0.9, 1.05, 1.15, 0.9]},
  {ticker: "MOON", name: "Moonshot", tag: null, score: 7980, price: 0.0034, supply: 1_000_000_000_000, ch: 22.8, holders: 6210, liq: 220000, status: "safe", mix: [1.05, 1.0, 0.8, 0.8, 1.5]},
  {ticker: "FINAL", name: "Final Cut", tag: null, score: 7320, price: 0.612, supply: 200_000_000, ch: -1.2, holders: 1820, liq: 180000, status: "safe", mix: [0.9, 0.95, 1.1, 1.1, 0.85]},
  {ticker: "CUT", name: "Cutthroat", tag: null, score: 6210, price: 0.078, supply: 1_000_000_000, ch: -8.4, holders: 1402, liq: 91000, status: "risk", mix: [1.0, 1.0, 0.9, 0.65, 0.9]},
  {ticker: "EDGE", name: "On The Edge", tag: null, score: 5840, price: 0.0021, supply: 10_000_000_000, ch: -2.0, holders: 980, liq: 64000, status: "risk", mix: [1.0, 1.05, 0.5, 0.95, 0.95]},
  {ticker: "SLICE", name: "Slice", tag: null, score: 5210, price: 0.0408, supply: 500_000_000, ch: -14.2, holders: 712, liq: 41000, status: "risk", mix: [0.9, 0.85, 0.9, 0.85, 0.85]},
  {ticker: "RUG", name: "Rugged", tag: null, score: 4180, price: 0.0009, supply: 1_000_000_000, ch: -28.6, holders: 312, liq: 12000, status: "risk", mix: [1.4, 0.6, 0.4, 0.15, 0.5]},
  {ticker: "DUST", name: "Dust", tag: null, score: 3420, price: 0.0003, supply: 1_000_000_000, ch: -34.1, holders: 184, liq: 4200, status: "risk", mix: [0.5, 0.4, 0.6, 0.7, 0.6]},
  {ticker: "GHOST", name: "Ghost", tag: null, score: 2810, price: 0.00018, supply: 1_000_000_000, ch: -41.8, holders: 92, liq: 1800, status: "risk", mix: [0.4, 0.3, 0.5, 0.5, 0.5]},
];

// Build the per-token component breakdown shown in the HP tooltip. `score`
// is the simulated 0..10000 HP value; the components are biased per `mix`
// and chosen so `Σ weight_i × component_i ≡ hp` — matching the engine
// identity so the tooltip's total exactly equals the bar's HP. Algorithm:
// distribute hp by weighted-normalized mix, then water-fill (clamp +
// redistribute the residual to free components proportionally to weight)
// until every value is in [0, 1] and the weighted sum hits hp.
export function buildComponents(score: number, mix: ComponentMix): HpComponents {
  const hp = Math.max(0, Math.min(1, score / 10000));
  const w = PRE_FILTER_WEIGHTS;
  const wArr = [w.velocity, w.effectiveBuyers, w.stickyLiquidity, w.retention, w.momentum];

  const k = wArr.reduce((s, ww, i) => s + ww * mix[i]!, 0) || 1;
  const c = mix.map((m) => (hp * m) / k);

  // Water-fill: clamp out-of-range values, then redistribute the residual
  // (= hp − current weighted sum) across unclamped components proportionally
  // to their weight. Converges in ≤4 iters for the simulated cohort; the
  // 12-iter cap is just a safety net for any future mix vector.
  for (let iter = 0; iter < 12; iter++) {
    let weighted = 0;
    let freeWeight = 0;
    const isFree: boolean[] = new Array(5);
    for (let i = 0; i < 5; i++) {
      const clamped = Math.max(0, Math.min(1, c[i]!));
      c[i] = clamped;
      weighted += wArr[i]! * clamped;
      isFree[i] = clamped > 0 && clamped < 1;
      if (isFree[i]) freeWeight += wArr[i]!;
    }
    const residual = hp - weighted;
    if (Math.abs(residual) < 1e-9 || freeWeight === 0) break;
    const bump = residual / freeWeight;
    for (let i = 0; i < 5; i++) if (isFree[i]) c[i] = c[i]! + bump;
  }

  return {
    velocity:        {score: c[0]!, weight: w.velocity,        label: COMPONENT_LABELS.velocity},
    effectiveBuyers: {score: c[1]!, weight: w.effectiveBuyers, label: COMPONENT_LABELS.effectiveBuyers},
    stickyLiquidity: {score: c[2]!, weight: w.stickyLiquidity, label: COMPONENT_LABELS.stickyLiquidity},
    retention:       {score: c[3]!, weight: w.retention,       label: COMPONENT_LABELS.retention},
    momentum:        {score: c[4]!, weight: w.momentum,        label: COMPONENT_LABELS.momentum},
  };
}

export type Mission = {label: string; cur: number; goal: number; unit?: string};

export const MISSIONS: Record<string, Mission[]> = {
  FILTER: [
    {label: "Reach 10,000 holders", cur: 8421, goal: 10000},
    {label: "Maintain $1.5M liquidity for 24h", cur: 18, goal: 24, unit: "h"},
    {label: "500 tx in last hour", cur: 412, goal: 500},
  ],
  BLOOD: [
    {label: "Reach 6,000 holders", cur: 5104, goal: 6000},
    {label: "Maintain $400k liquidity", cur: 412000, goal: 400000, unit: "$"},
    {label: "Survive 48h above filter", cur: 31, goal: 48, unit: "h"},
  ],
};

export type FeedType = "enter" | "risk" | "pump" | "whale" | "mission" | "launch" | "cross" | "lead";

export type FeedItem = {
  id: number;
  type: FeedType;
  ticker: string;
  text: string;
  ago: number;
};

export const FEED_TEMPLATES: {type: FeedType; text: (t: string, n?: number) => string}[] = [
  {type: "enter", text: (t) => `$${t} just entered the top 10`},
  {type: "risk", text: (t) => `$${t} is about to be filtered 🔻`},
  {type: "pump", text: (t, n) => `$${t} up ${n}% in the last hour`},
  {type: "whale", text: (t, n) => `Whale bought ${n} $${t}`},
  {type: "mission", text: (t) => `$${t} cleared a mission`},
  {type: "launch", text: (t) => `New token launched · $${t}`},
  {type: "cross", text: (t) => `$${t} crossed the filter line`},
  {type: "lead", text: (t) => `$${t} took the lead`},
];

export const FEED_TICKERS = ["FILTER", "BLOOD", "KING", "SURVIVE", "MOON", "FINAL", "CUT", "EDGE", "SLICE", "RUG", "DUST", "GHOST"];
