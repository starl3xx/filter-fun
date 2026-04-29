// Seed data + simulation templates. Replace with real indexer/websocket data
// when wired; the live-data hooks read these as starting state.

export type TokenStatus = "finalist" | "safe" | "risk";

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
};

// Seeds are spread across 1B / 100B / 1T supplies so the simulated cohort has
// the same "high HP, low mcap" tension the real game will have — RUG and DUST
// have low scores AND small mcaps, but MOON has a massive supply with a small
// price, putting its mcap in the middle of the pack despite being mid-rank.
export const SEED_TOKENS: Omit<Token, "spark" | "rank" | "mcap">[] = [
  {ticker: "FILTER", name: "Filter", tag: "protocol", score: 9420, price: 0.428, supply: 1_000_000_000, ch: 12.4, holders: 8421, liq: 1840000, status: "finalist"},
  {ticker: "BLOOD", name: "Bloodline", tag: null, score: 9180, price: 0.0091, supply: 100_000_000_000, ch: 38.2, holders: 5104, liq: 412000, status: "finalist"},
  {ticker: "KING", name: "Kingmaker", tag: null, score: 8720, price: 1.84, supply: 50_000_000, ch: 6.9, holders: 3982, liq: 980000, status: "safe"},
  {ticker: "SURVIVE", name: "Survive", tag: null, score: 8410, price: 0.214, supply: 1_000_000_000, ch: 4.1, holders: 2841, liq: 312000, status: "safe"},
  {ticker: "MOON", name: "Moonshot", tag: null, score: 7980, price: 0.0034, supply: 1_000_000_000_000, ch: 22.8, holders: 6210, liq: 220000, status: "safe"},
  {ticker: "FINAL", name: "Final Cut", tag: null, score: 7320, price: 0.612, supply: 200_000_000, ch: -1.2, holders: 1820, liq: 180000, status: "safe"},
  {ticker: "CUT", name: "Cutthroat", tag: null, score: 6210, price: 0.078, supply: 1_000_000_000, ch: -8.4, holders: 1402, liq: 91000, status: "risk"},
  {ticker: "EDGE", name: "On The Edge", tag: null, score: 5840, price: 0.0021, supply: 10_000_000_000, ch: -2.0, holders: 980, liq: 64000, status: "risk"},
  {ticker: "SLICE", name: "Slice", tag: null, score: 5210, price: 0.0408, supply: 500_000_000, ch: -14.2, holders: 712, liq: 41000, status: "risk"},
  {ticker: "RUG", name: "Rugged", tag: null, score: 4180, price: 0.0009, supply: 1_000_000_000, ch: -28.6, holders: 312, liq: 12000, status: "risk"},
  {ticker: "DUST", name: "Dust", tag: null, score: 3420, price: 0.0003, supply: 1_000_000_000, ch: -34.1, holders: 184, liq: 4200, status: "risk"},
  {ticker: "GHOST", name: "Ghost", tag: null, score: 2810, price: 0.00018, supply: 1_000_000_000, ch: -41.8, holders: 92, liq: 1800, status: "risk"},
];

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
