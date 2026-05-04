/// Cost / ROI calculator math (spec §45).
///
/// Pure functions only — no React, no DOM, no contract reads. Consumers
/// pass in the raw cost values they have on hand (slot cost in wei, current
/// champion pool in ETH, ETH/USD rate) and get back the projection numbers
/// the calculator UI renders.
///
/// Why a separate module:
///   1. Tests can hit the math directly without mounting a tree.
///   2. The docs page (separate repo) can reproduce the same formulas
///      against the same constants by reading this file as the spec source.
///   3. Bugbot historically flags inline math inside JSX as a smell — keep
///      formulas in one named place.

import {formatEther, parseEther} from "viem";

import {MAX_LAUNCHES} from "./abi";

// ============================================================ constants

/// 0.01 ETH base cost — spec §4.3 (locked 2026-05-02, reduced 5× from
/// the earlier 0.05 ETH base). Mirrored from the contract's
/// `BASE_LAUNCH_COST` immutable; the on-chain value is canonical, this
/// constant is for static-view fallbacks (docs page, calculator presets
/// when no contract read is available).
export const BASE_LAUNCH_COST_WEI: bigint = parseEther("0.01");

/// Re-exported for callers that import from `economics.ts` rather than the
/// abi module — the cost formula here uses the same canonical value, so
/// a single divergence point is impossible.
export {MAX_LAUNCHES};

/// Spec §10.2 — flat 20 bps of trading volume to the creator while live.
export const CREATOR_FEE_BPS = 20; // 0.20%

/// Spec §10.4 — 250 bps of the losers pot to the winning creator, paid
/// before the standard settlement split.
export const CHAMPION_BOUNTY_BPS = 250; // 2.5%

/// Spec §11.1 — 10% of the losers pot is deployed as permanent POL into
/// the winner's pool. Used for the "POL backing if you win" projection.
export const POL_SLICE_BPS = 1000; // 10%

/// Spec §10.3 + §10.6 (Epic 1.16, locked 2026-05-02): creator-fee accrual is perpetual.
/// Winners earn 0.20% of every swap on their pool forever — there is no time cap and no
/// settlement cap. The long-tail projection below assumes a geometric-decay weekly volume
/// model: week 1 = launch-week volume, week N = `volume × WEEKLY_DECAY^(N-1)`. Defaults
/// chosen to be visibly conservative — a 50% week-over-week decay implies the asymptotic
/// total is `2 × launch-week volume` at most, which a reasonable creator can sanity-check.
export const POST_SETTLEMENT_LONGTAIL_WEEKS = 12; // weeks projected past settlement
export const POST_SETTLEMENT_WEEKLY_DECAY = 0.5; // 50% week-over-week volume decay

/// Hardcoded ETH/USD fallback. Replace with a live feed once the indexer
/// exposes one — see spec §45.3 (USD display is mandatory; price source is
/// allowed to be a fallback for v1).
/// TODO: live price feed — wire to indexer's `/season.ethUsd` once it ships.
export const ETH_USD_FALLBACK = 3500;

// ============================================================ price helpers

/// USD value of a wei amount at the given ETH/USD rate.
export function weiToUsd(wei: bigint, ethUsd: number = ETH_USD_FALLBACK): number {
  return Number(formatEther(wei)) * ethUsd;
}

/// "$35" / "$1,234" / "$1.2M". Compact notation kicks in at 10k+ so the
/// breakeven sentence reads naturally ("$5k in trading volume" not "$5,000").
///
/// The M-branch threshold is 999.5k (not 1M exactly) so that values just
/// below a million — e.g. $999,500 — escalate to "$1.00M" rather than
/// rounding to "$1000k" via the k-branch's `.toFixed(0)`.
export function fmtUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "$—";
  const abs = Math.abs(usd);
  if (abs >= 999_500) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `$${(usd / 1_000).toFixed(0)}k`;
  if (abs >= 1_000) return `$${usd.toLocaleString("en-US", {maximumFractionDigits: 0})}`;
  if (abs >= 1) return `$${usd.toFixed(0)}`;
  return `$${usd.toFixed(2)}`;
}

/// Signed USD: leading `+`/`-` so the calculator's net-out-of-pocket can
/// surface "you net +$120" vs "you spend −$45" without sign ambiguity.
export function fmtUsdSigned(usd: number): string {
  if (!Number.isFinite(usd)) return "$—";
  if (usd > 0) return `+${fmtUsd(usd)}`;
  if (usd < 0) return `−${fmtUsd(-usd)}`;
  return "$0";
}

/// "Ξ0.0XXX" with four decimals — the calculator's outputs are small ETH
/// amounts where two decimals collapses adjacent values, and three is the
/// /launch CostPanel default. Four decimals reads cleanly for fractional-
/// ETH bounty projections without scientific notation.
export function fmtEth4(eth: number): string {
  if (!Number.isFinite(eth)) return "Ξ —";
  return `Ξ${eth.toFixed(4)}`;
}

// ============================================================ cost formula

/// Spec §4.3 — quadratic per-slot cost. The contract is canonical; this
/// pure function reproduces the formula for static views (docs page, the
/// calculator's per-slot preset table when no chain state is available).
export function slotCostWei(
  slotIndex: number,
  baseLaunchCostWei: bigint = BASE_LAUNCH_COST_WEI,
): bigint {
  // Bigint math doesn't support fractional exponents, so compute the
  // multiplier in a Number and apply it back. Slot index is small (0..11)
  // so float precision is plenty.
  const ratio = slotIndex / MAX_LAUNCHES;
  const multiplier = 1 + ratio * ratio;
  // Scale by 1e6 to preserve four sig figs without floating-point drift.
  const scaled = BigInt(Math.round(multiplier * 1_000_000));
  return (baseLaunchCostWei * scaled) / 1_000_000n;
}

// ============================================================ calculator

export type Outcome = "filtered" | "survives" | "wins";

export type CalcInputs = {
  /// User-supplied estimate of peak market cap during the week (USD).
  peakMcUsd: number;
  /// User-supplied estimate of weekly trading volume (USD).
  weeklyVolumeUsd: number;
  outcome: Outcome;
  /// Current slot's launch cost in wei (live read from the contract).
  slotCostWei: bigint;
  /// Refundable stake in wei. Equal to slotCost when stake mode is on,
  /// 0 when off. Forfeited on `filtered`, refunded on `survives`/`wins`.
  stakeWei: bigint;
  /// ETH/USD conversion rate. `ETH_USD_FALLBACK` if no live feed.
  ethUsd: number;
};

export type CalcOutputs = {
  /// Net cost in USD across the week (positive = creator paid out of pocket;
  /// negative = creator earned more than they spent).
  netUsd: number;
  /// Creator-fee revenue THIS WEEK in USD (full week if survives/wins, ~½
  /// if filtered — fees stop because LP is unwound at the cut, per spec
  /// §10.3 + Epic 1.16 perpetual model: the cap is implicit in the pool
  /// lifecycle, not enforced in code).
  creatorFeesUsd: number;
  /// Champion-bounty range in USD. `null` when outcome is not `wins`.
  bountyRangeUsd: {low: number; high: number} | null;
  /// POL backing in ETH. `null` when outcome is not `wins`.
  polBackingEth: number | null;
  /// Trading volume needed to recoup the launch cost via 0.20% fees alone.
  breakevenVolumeUsd: number;
  /// Epic 1.16 (spec §10.3 + §10.6): post-settlement perpetual long-tail
  /// projection in USD. Sums `POST_SETTLEMENT_LONGTAIL_WEEKS` of decaying
  /// post-settlement volume × CREATOR_FEE_BPS. `null` when outcome is not
  /// `wins`. This is now the dominant ROI term for winners over multi-month
  /// horizons — the calculator's narrative copy gates on this being non-zero
  /// to surface the "you keep earning forever" framing.
  postSettlementLongTailUsd: number | null;
};

export function calculateOutcomes(input: CalcInputs): CalcOutputs {
  const slotCostUsd = weiToUsd(input.slotCostWei, input.ethUsd);
  const stakeUsd = weiToUsd(input.stakeWei, input.ethUsd);

  // Spec §10.3 (Epic 1.16): creator fees accrue forever for winners. For filtered +
  // non-winning tokens the LP is unwound at the cut, so trading stops and so does the
  // fee stream — the cap is implicit in the pool lifecycle, not in the contract. We
  // approximate "filtered" as half the week of trading (the filter fires mid-week;
  // volume traded before that point still earned the creator their slice). Survives /
  // wins keep the full launch week revenue.
  const feeShare = CREATOR_FEE_BPS / 10_000; // 0.0020
  const accrualFactor = input.outcome === "filtered" ? 0.5 : 1;
  const creatorFeesUsd = input.weeklyVolumeUsd * feeShare * accrualFactor;

  // Epic 1.16 (spec §10.3 + §10.6): post-settlement perpetual long-tail. For wins, sum
  // a 12-week geometric series of decaying weekly volume at 50% w/w decay. The launch-
  // week revenue (`creatorFeesUsd`) is the FIRST week; the long-tail captures weeks 2..N
  // as ADDITIONAL revenue past settlement. Survives/filtered cases are null — only the
  // winning pool survives past settlement to keep generating fees.
  let postSettlementLongTailUsd: number | null = null;
  if (input.outcome === "wins") {
    let cumulative = 0;
    let weekVolume = input.weeklyVolumeUsd;
    for (let week = 1; week < POST_SETTLEMENT_LONGTAIL_WEEKS; week++) {
      weekVolume *= POST_SETTLEMENT_WEEKLY_DECAY;
      cumulative += weekVolume * feeShare;
    }
    postSettlementLongTailUsd = cumulative;
  }

  // Net out-of-pocket: slot cost is always paid; stake is forfeited only
  // on `filtered`; bounty offsets cost only on `wins`. We sign so that a
  // negative result (creator earned > spent) renders cleanly downstream.
  const stakeForfeit = input.outcome === "filtered" ? stakeUsd : 0;

  // Bounty range — losers pot estimate uses the user's peak-MC slider as
  // a proxy. The losers pot is unwound LP from the bottom 6 tokens, which
  // correlates loosely with the field's peak market caps. We expose a
  // ±4× spread (5% → 20% of peak MC) to make the uncertainty visible
  // rather than implying a single-point projection. Tunable; see §45.3
  // commentary on "show as range to acknowledge uncertainty."
  const losersPotLowUsd = input.peakMcUsd * 0.05;
  const losersPotHighUsd = input.peakMcUsd * 0.20;
  const bountyLow = losersPotLowUsd * (CHAMPION_BOUNTY_BPS / 10_000);
  const bountyHigh = losersPotHighUsd * (CHAMPION_BOUNTY_BPS / 10_000);
  const bountyMidpoint = (bountyLow + bountyHigh) / 2;

  // Net cost: positive = creator out of pocket, negative = net profit.
  // For `wins`, subtract the bounty midpoint AND the perpetual long-tail projection
  // (Epic 1.16) as the central estimate. The long-tail dominates over multi-month
  // horizons — a creator who only sees launch-week revenue here would understate the
  // win-case ROI by more than 1× for the conservative-decay model.
  const bountyOffset = input.outcome === "wins" ? bountyMidpoint : 0;
  const longTailOffset = postSettlementLongTailUsd ?? 0;
  const netUsd = slotCostUsd + stakeForfeit - creatorFeesUsd - bountyOffset - longTailOffset;

  // POL backing — only meaningful when the creator wins. 10% of the
  // estimated losers pot becomes permanent LP backing the winner's token.
  // Use the midpoint of the same losers-pot range; users see "~Ξ X locked
  // LP forever" as a qualitative figure, not a guarantee.
  const polEthMid =
    input.outcome === "wins"
      ? ((losersPotLowUsd + losersPotHighUsd) / 2) * (POL_SLICE_BPS / 10_000) / input.ethUsd
      : null;

  // Breakeven on launch cost alone (does NOT account for stake, which is
  // separate from the fee-vs-cost equation). The number creators ask for
  // is "what volume needs to flow through my pool for the slot to pay
  // for itself."
  const breakevenVolumeUsd = slotCostUsd / feeShare;

  return {
    netUsd,
    creatorFeesUsd,
    bountyRangeUsd: input.outcome === "wins" ? {low: bountyLow, high: bountyHigh} : null,
    polBackingEth: polEthMid,
    breakevenVolumeUsd,
    postSettlementLongTailUsd,
  };
}

// ============================================================ presets

export type Preset = {
  id: "realistic" | "solid" | "viral";
  label: string;
  blurb: string;
  peakMcUsd: number;
  weeklyVolumeUsd: number;
  outcome: Outcome;
};

/// Spec §45.4 — three pre-baked scenarios. The realistic preset is
/// intentionally a loss case (most launches are filtered); a creator who
/// only sees the calculator's optimistic positions doesn't get the right
/// picture of what's likely.
export const PRESETS: ReadonlyArray<Preset> = [
  {
    id: "realistic",
    label: "Realistic launch",
    blurb: "Most likely outcome — token gets filtered Friday.",
    peakMcUsd: 50_000,
    weeklyVolumeUsd: 100_000,
    outcome: "filtered",
  },
  {
    id: "solid",
    label: "Solid token",
    blurb: "Decent traction, survives the cut, doesn't win.",
    peakMcUsd: 500_000,
    weeklyVolumeUsd: 1_000_000,
    outcome: "survives",
  },
  {
    id: "viral",
    label: "Viral winner",
    /// Epic 1.16: copy gates on the perpetual long-tail being the dominant ROI term.
    blurb: "Your token wins — and you keep earning 0.20% of every trade forever.",
    peakMcUsd: 5_000_000,
    weeklyVolumeUsd: 10_000_000,
    outcome: "wins",
  },
];

// ============================================================ slider scale

/// Log-scale mapping for the calculator sliders. Slider t ∈ [0, 100]
/// maps to value ∈ [min, max] on a log curve so the linear handle range
/// covers $1k → $10M evenly in orders of magnitude rather than linearly.
export type LogScale = {min: number; max: number};

export function logToValue(t: number, scale: LogScale): number {
  const tt = Math.max(0, Math.min(100, t)) / 100;
  const log = Math.log10(scale.min) + (Math.log10(scale.max) - Math.log10(scale.min)) * tt;
  return Math.pow(10, log);
}

export function valueToLog(value: number, scale: LogScale): number {
  const v = Math.max(scale.min, Math.min(scale.max, value));
  const t = (Math.log10(v) - Math.log10(scale.min)) / (Math.log10(scale.max) - Math.log10(scale.min));
  return t * 100;
}

export const PEAK_MC_SCALE: LogScale = {min: 1_000, max: 10_000_000};
/// Volume scale max set to $10M so the "Viral winner" preset (which uses
/// $10M weekly volume) renders inside the slider range. A $5M ceiling
/// would clamp the viral preset on first slider interaction, silently
/// halving creator-fees and breaking preset/value coherence.
export const WEEKLY_VOLUME_SCALE: LogScale = {min: 1_000, max: 10_000_000};
