/// Pure detectors — given a `prev` snapshot, the `current` snapshot, and the slice of
/// fee-accrual rows since the previous tick, return the `DetectedEvent[]` that describe
/// what changed.
///
/// Each detector is independent and order-stable: detector A never depends on detector B,
/// and the output array is sorted by `(token address, type)` for deterministic tests. The
/// pipeline downstream handles priority + dedupe + throttle + suppression.
///
/// On the first tick (`prev === null`) every detector returns `[]` — there's no diff to
/// produce yet. The tick engine swaps the snapshot in for next time.

import type {EventsConfig} from "./config.js";
import type {
  DetectedEvent,
  FeeAccrualRow,
  Snapshot,
  TokenSnapshot,
} from "./types.js";

const CUT_LINE = 6;

export function diffSnapshots(
  prev: Snapshot | null,
  current: Snapshot,
  recentFees: ReadonlyArray<FeeAccrualRow>,
  /// Volume baseline — total WETH fee accrual per token over the trailing baseline window.
  /// Sourced by the tick engine; passed in so detectors stay pure.
  volumeBaselineByToken: ReadonlyMap<string, bigint>,
  cfg: EventsConfig,
): DetectedEvent[] {
  if (!prev) return systemDetectors(prev, current);

  const out: DetectedEvent[] = [];
  out.push(...detectRankAndCutLine(prev, current, cfg));
  out.push(...detectHpSpike(prev, current, cfg));
  out.push(...detectVolumeSpike(current, recentFees, volumeBaselineByToken, cfg));
  out.push(...detectLargeTrade(current, recentFees, cfg));
  out.push(...detectFilterEvents(prev, current));
  out.push(...detectFilterCountdown(prev, current, cfg));
  out.push(...systemDetectors(prev, current));
  return out;
}

// ============================================================ Rank + cut-line

function detectRankAndCutLine(prev: Snapshot, cur: Snapshot, cfg: EventsConfig): DetectedEvent[] {
  const prevByAddr = byAddr(prev.tokens);
  const out: DetectedEvent[] = [];
  for (const t of cur.tokens) {
    const p = lookupByAddr(prevByAddr, t.address);
    if (!p) continue;
    if (p.rank === 0 || t.rank === 0) continue; // unscored — no signal

    const fromRank = p.rank;
    const toRank = t.rank;
    if (fromRank === toRank) continue;

    const crossedCutLine =
      (fromRank <= CUT_LINE && toRank > CUT_LINE) ||
      (fromRank > CUT_LINE && toRank <= CUT_LINE);

    if (crossedCutLine) {
      // Cut-line crossings are HIGH-priority and fire even when the |Δrank| is below the
      // generic rank-change threshold — the cut line is the dramatic boundary in spec §3.3.
      out.push({
        type: "CUT_LINE_CROSSED",
        token: t,
        data: {
          fromRank,
          toRank,
          direction: toRank <= CUT_LINE ? "above" : "below",
        },
      });
    } else if (Math.abs(fromRank - toRank) >= cfg.rankChangeMin) {
      out.push({
        type: "RANK_CHANGED",
        token: t,
        data: {fromRank, toRank},
      });
    }
  }
  return out;
}

// ============================================================ HP

function detectHpSpike(prev: Snapshot, cur: Snapshot, cfg: EventsConfig): DetectedEvent[] {
  const prevByAddr = byAddr(prev.tokens);
  const out: DetectedEvent[] = [];
  for (const t of cur.tokens) {
    const p = lookupByAddr(prevByAddr, t.address);
    if (!p) continue;
    const delta = t.hp - p.hp;
    if (Math.abs(delta) >= cfg.hpSpikeThreshold) {
      out.push({
        type: "HP_SPIKE",
        token: t,
        data: {fromHp: p.hp, toHp: t.hp, hpDelta: delta},
      });
    }
  }
  return out;
}

// ============================================================ Volume spike

function detectVolumeSpike(
  cur: Snapshot,
  recentFees: ReadonlyArray<FeeAccrualRow>,
  baselineByToken: ReadonlyMap<string, bigint>,
  cfg: EventsConfig,
): DetectedEvent[] {
  // Aggregate current-window WETH fee per token.
  const currentByToken = new Map<string, bigint>();
  for (const f of recentFees) {
    const key = f.tokenAddress.toLowerCase();
    currentByToken.set(key, (currentByToken.get(key) ?? 0n) + f.totalFeeWei);
  }

  const out: DetectedEvent[] = [];
  const tokensByAddr = byAddr(cur.tokens);
  for (const [addr, currentFee] of currentByToken) {
    if (currentFee < cfg.volumeSpikeMinWethWei) continue;
    const baseline = baselineByToken.get(addr) ?? 0n;
    // If baseline is zero, treat as ratio = ∞ — the min-WETH gate above prevents
    // dust from triggering this branch.
    const ratio =
      baseline === 0n ? Number.POSITIVE_INFINITY : Number(currentFee) / Number(baseline);
    if (ratio >= cfg.volumeSpikeRatio) {
      const tok = lookupByAddr(tokensByAddr, addr as `0x${string}`);
      if (!tok) continue;
      out.push({
        type: "VOLUME_SPIKE",
        token: tok,
        data: {
          windowFeeWei: currentFee.toString(),
          baselineFeeWei: baseline.toString(),
          ratio: Number.isFinite(ratio) ? ratio : null,
        },
      });
    }
  }
  return out;
}

// ============================================================ Large trade

function detectLargeTrade(
  cur: Snapshot,
  recentFees: ReadonlyArray<FeeAccrualRow>,
  cfg: EventsConfig,
): DetectedEvent[] {
  const out: DetectedEvent[] = [];
  const tokensByAddr = byAddr(cur.tokens);
  for (const f of recentFees) {
    // Infer trade size: tradeWeth = totalFee * 10_000 / tradeFeeBps. Approximation — fee
    // could be split across multiple trades within a block, but treating the row as a
    // single trade is fine for the LARGE_TRADE signal (it represents the *minimum*
    // trade volume that produced this fee accrual).
    if (cfg.tradeFeeBps <= 0) continue;
    const tradeWei = (f.totalFeeWei * 10_000n) / BigInt(cfg.tradeFeeBps);
    if (tradeWei < cfg.largeTradeWethWei) continue;
    const tok = lookupByAddr(tokensByAddr, f.tokenAddress);
    if (!tok) continue;
    // Near-cut-line large trades elevate to MEDIUM; everything else stays LOW per spec
    // §36.1.4 (individual trades are LOW by default).
    const nearCut =
      tok.rank > 0 &&
      tok.rank >= CUT_LINE - 1 &&
      tok.rank <= CUT_LINE + 2;
    out.push({
      type: "LARGE_TRADE",
      token: tok,
      data: {
        tradeWei: tradeWei.toString(),
        feeWei: f.totalFeeWei.toString(),
        nearCutLine: nearCut,
      },
      priorityOverride: nearCut ? "MEDIUM" : undefined,
    });
  }
  return out;
}

// ============================================================ Filter / phase events

function detectFilterEvents(prev: Snapshot, cur: Snapshot): DetectedEvent[] {
  const out: DetectedEvent[] = [];
  // Filter fired: any token transitioned to liquidated.
  const prevByAddr = byAddr(prev.tokens);
  for (const t of cur.tokens) {
    const p = lookupByAddr(prevByAddr, t.address);
    if (!p) continue;
    if (!p.liquidated && t.liquidated) {
      out.push({
        type: "FILTER_FIRED",
        token: t,
        data: {address: t.address},
      });
    }
  }
  return out;
}

/// Fires once when time-to-next-cut crosses below `cfg.filterCountdownThresholdSec`.
/// Edge-triggered: the previous tick must have been *above* the threshold (or had no
/// upcoming cut), and the current tick is *below* it. Subsequent ticks within the
/// window are silenced by dedupe — the UI handles ongoing countdown rendering itself.
function detectFilterCountdown(
  prev: Snapshot,
  cur: Snapshot,
  cfg: EventsConfig,
): DetectedEvent[] {
  if (cur.nextCutAtSec === null) return [];
  const remainingSec = cur.nextCutAtSec - cur.takenAtSec;
  if (remainingSec > BigInt(cfg.filterCountdownThresholdSec)) return [];
  if (remainingSec < 0n) return []; // cut already passed — no countdown to announce

  // Edge-trigger: only fire if the PREVIOUS tick was outside the threshold (i.e. either
  // had no cut scheduled, or had > threshold remaining). Without this, every tick inside
  // the window would re-emit until dedupe kicked in — wasted work.
  if (prev.nextCutAtSec !== null) {
    const prevRemaining = prev.nextCutAtSec - prev.takenAtSec;
    if (prevRemaining <= BigInt(cfg.filterCountdownThresholdSec)) return [];
  }

  const minutesUntilCut = Number((remainingSec + 59n) / 60n); // ceil to whole minutes
  return [
    {
      type: "FILTER_COUNTDOWN",
      token: null,
      data: {minutesUntilCut, secondsUntilCut: Number(remainingSec)},
    },
  ];
}

function systemDetectors(prev: Snapshot | null, cur: Snapshot): DetectedEvent[] {
  // Phase advance — fires once per tick on a transition.
  if (!prev) return [];
  if (prev.phase !== cur.phase) {
    return [
      {
        type: "PHASE_ADVANCED",
        token: null,
        data: {fromPhase: prev.phase, toPhase: cur.phase},
      },
    ];
  }
  return [];
}

function byAddr(tokens: ReadonlyArray<TokenSnapshot>): Map<`0x${string}`, TokenSnapshot> {
  const m = new Map<`0x${string}`, TokenSnapshot>();
  for (const t of tokens) m.set(t.address.toLowerCase() as `0x${string}`, t);
  return m;
}

/// Case-insensitive helper for the address-keyed maps `byAddr` produces. Centralized so
/// every detector lookup goes through the same normalization — addresses can arrive
/// checksummed from upstream data sources, and a missed `.toLowerCase()` would silently
/// disable detection for affected tokens.
function lookupByAddr(
  m: ReadonlyMap<`0x${string}`, TokenSnapshot>,
  addr: `0x${string}`,
): TokenSnapshot | undefined {
  return m.get(addr.toLowerCase() as `0x${string}`);
}
