import {DEFAULT_CONFIG, score, type Address, type Phase, type ScoredToken, type ScoringConfig, type TokenStats} from "../index.js";
import type {BuyEvent, HarnessEvent, LpAddEvent, LpRemoveEvent, SellEvent} from "./events.js";
import type {TickRecord} from "./output.js";

/// Replay-engine config. All windows are in seconds, matching the scoring
/// package's bigint-seconds convention.
export interface HarnessConfig {
  /// Tick boundary cadence. HP is computed at every multiple of this from
  /// the simulation start. 60s is the spec-aligned default; lower values
  /// (10–30s) are useful for debugging short scenarios, higher values
  /// (300s) for long historical replays where per-minute resolution is
  /// noise.
  tickGranularitySec: number;
  /// Long retention anchor — the holder set at (now − this) feeds the
  /// long-conviction score. Spec §6.4.4 default is 24h.
  retentionAnchorLongSec: number;
  /// Short retention anchor — the holder set at (now − this) feeds the
  /// short-conviction score (catches tokens bleeding fresh holders even
  /// while old holders look stable). Default 1h. Set to 0 to disable.
  retentionAnchorShortSec: number;
  /// Window over which `recentLiquidityRemovedWeth` is summed for the
  /// sticky-liq penalty. Spec §6.4.3 default 1h.
  recentLpWindowSec: number;
  /// Time-weighted average window for `avgLiquidityDepthWeth`. Spec uses
  /// a trailing window matching the retention anchor (24h).
  avgLpWindowSec: number;
  /// Wall-clock anchor for ISO-8601 timestamps in `TickRecord.timestamp`.
  /// Default 1970-01-01T00:00:00Z, so `tsSec` and `timestamp` agree
  /// trivially; historical replays should set this to the corpus epoch.
  startWallTimeMs: number;
  /// Scoring config (weights, dampening, momentum cap). Defaults to
  /// `DEFAULT_CONFIG` from the scoring package; override per scenario to
  /// test phase weights or knob sensitivity.
  scoringConfig: ScoringConfig;
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  tickGranularitySec: 60,
  retentionAnchorLongSec: 24 * 3600,
  retentionAnchorShortSec: 3600,
  recentLpWindowSec: 3600,
  avgLpWindowSec: 24 * 3600,
  startWallTimeMs: 0,
  scoringConfig: DEFAULT_CONFIG,
};

/// Snapshot of holders at a single timestamp. The engine keeps a sorted
/// list per token and binary-searches for retention-anchor lookups.
interface HolderSnapshot {
  ts: bigint;
  holders: Set<Address>;
}

/// LP timeline entry. `protocol: true` entries are excluded from the
/// recent-withdrawal sum (spec §6.4.3 indexer responsibility — system
/// actions like filter-event teardowns aren't market signal).
interface LpEvent {
  ts: bigint;
  delta: bigint; // signed: +ve add, -ve remove
  protocol: boolean;
}

/// Per-token simulation state. Reset on each engine.run(); the engine
/// owns mutation, scenarios are pure event producers.
class TokenState {
  readonly token: Address;
  /// `wallet → cumulative buy volume` — fed to TokenStats.volumeByWallet.
  readonly volumeByWallet: Map<Address, bigint> = new Map();
  /// All buys in time order (the engine never trims; scoring's velocity
  /// applies its own time-decay).
  readonly buys: BuyEvent[] = [];
  readonly sells: SellEvent[] = [];
  /// Live wallet balances (1:1 with WETH-in for buys, debited by sells).
  /// Holder count = wallets with `balance > 0`.
  readonly balances: Map<Address, bigint> = new Map();
  /// Sorted by ts ascending. New snapshots appended when holder set changes.
  readonly holderSnapshots: HolderSnapshot[] = [];
  /// All LP events in time order (used to compute avgLpDepth + recentRemoved).
  readonly lpEvents: LpEvent[] = [];
  /// Current LP depth (running sum of all lp deltas, both protocol + market).
  lpDepthWeth: bigint = 0n;
  /// Last computed pre-momentum composite — fed back as priorBaseComposite
  /// next tick.
  priorBaseComposite: number | undefined = undefined;

  constructor(token: Address) {
    this.token = token;
  }

  applyBuy(ev: BuyEvent): void {
    this.volumeByWallet.set(ev.wallet, (this.volumeByWallet.get(ev.wallet) ?? 0n) + ev.amountWeth);
    this.buys.push(ev);
    this.balances.set(ev.wallet, (this.balances.get(ev.wallet) ?? 0n) + ev.amountWeth);
  }

  applySell(ev: SellEvent): void {
    this.sells.push(ev);
    const cur = this.balances.get(ev.wallet) ?? 0n;
    const next = cur - ev.amountWeth;
    // Clamp at zero — harness rejects oversells silently rather than tracking
    // shorts. Scoring's net-velocity math handles the per-wallet net.
    if (next <= 0n) this.balances.delete(ev.wallet);
    else this.balances.set(ev.wallet, next);
  }

  applyLpAdd(ev: LpAddEvent): void {
    this.lpEvents.push({ts: ev.ts, delta: ev.amountWeth, protocol: ev.protocol === true});
    this.lpDepthWeth += ev.amountWeth;
  }

  applyLpRemove(ev: LpRemoveEvent): void {
    this.lpEvents.push({ts: ev.ts, delta: -ev.amountWeth, protocol: ev.protocol === true});
    this.lpDepthWeth -= ev.amountWeth;
    if (this.lpDepthWeth < 0n) this.lpDepthWeth = 0n; // clamp; scenarios may
                                                      // approximate over-removes.
  }

  /// Append a snapshot iff holders changed since the last one.
  snapshot(ts: bigint): void {
    const current = new Set<Address>();
    for (const [w, bal] of this.balances) if (bal > 0n) current.add(w);
    const last = this.holderSnapshots[this.holderSnapshots.length - 1];
    if (last && setsEqual(last.holders, current)) return;
    this.holderSnapshots.push({ts, holders: current});
  }

  /// Holder set at or before `queryTs`. If `queryTs` precedes the earliest
  /// snapshot (sim warmup), return the earliest one — that gives sensible
  /// "retention since launch" behavior for early ticks.
  holdersAt(queryTs: bigint): ReadonlySet<Address> {
    const snaps = this.holderSnapshots;
    if (snaps.length === 0) return EMPTY_SET;
    if (queryTs < snaps[0]!.ts) return snaps[0]!.holders;
    // Binary search for largest ts <= queryTs.
    let lo = 0;
    let hi = snaps.length - 1;
    while (lo < hi) {
      const mid = lo + Math.ceil((hi - lo) / 2);
      if (snaps[mid]!.ts <= queryTs) lo = mid;
      else hi = mid - 1;
    }
    return snaps[lo]!.holders;
  }

  /// Time-weighted average LP depth over the trailing window. We integrate
  /// over LP events: between consecutive events, depth is constant, so
  /// trapezoidal sum reduces to (depth × duration). Returns 0 if no LP
  /// history yet.
  avgLpDepthOver(now: bigint, windowSec: number): bigint {
    if (windowSec <= 0 || this.lpEvents.length === 0) return this.lpDepthWeth;
    const winStart = now - BigInt(windowSec);
    let weighted = 0n;
    let prevTs = winStart > 0n ? winStart : 0n;
    let depthBefore = 0n;
    // Replay LP deltas to find the depth at `winStart`.
    for (const e of this.lpEvents) {
      if (e.ts <= prevTs) depthBefore += e.delta;
      else break;
    }
    if (depthBefore < 0n) depthBefore = 0n;
    let depth = depthBefore;
    for (const e of this.lpEvents) {
      if (e.ts <= prevTs) continue;
      if (e.ts >= now) break;
      weighted += depth * (e.ts - prevTs);
      depth += e.delta;
      if (depth < 0n) depth = 0n;
      prevTs = e.ts;
    }
    weighted += depth * (now - prevTs);
    const span = now - winStart;
    if (span <= 0n) return this.lpDepthWeth;
    return weighted / span;
  }

  /// Sum of *market* LP removes (excluding `protocol: true`) within the
  /// trailing window. Mirrors the indexer's responsibility (spec §6.4.3) to
  /// scrub system-action LP changes from the sticky-liq penalty input.
  recentLpRemovedOver(now: bigint, windowSec: number): bigint {
    if (windowSec <= 0) return 0n;
    const cutoff = now - BigInt(windowSec);
    let removed = 0n;
    for (const e of this.lpEvents) {
      if (e.ts < cutoff) continue;
      if (e.ts > now) break;
      if (e.protocol) continue;
      if (e.delta < 0n) removed += -e.delta;
    }
    return removed;
  }

  /// Returns `true` if anything has happened (so we should include this
  /// token in the score cohort). Tokens that have been launched but seen
  /// no buys are still scored — a freshly launched token has 0 across
  /// non-retention components, which is the right behavior.
  isLive(): boolean {
    return this.holderSnapshots.length > 0 || this.lpEvents.length > 0;
  }
}

const EMPTY_SET: ReadonlySet<Address> = new Set();

function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/// Replays an event stream tick-by-tick and emits a HP timeseries.
///
/// **Determinism.** Given identical events + config the engine produces
/// byte-identical `TickRecord[]` output. This is load-bearing for Track E,
/// which diffs synthetic baselines against historical replays.
///
/// **Phase tracking.** A `PHASE` event mid-stream switches the active
/// scoring phase (and therefore weights) for subsequent ticks. The engine
/// rebuilds the per-token `ScoringConfig` lazily so the scenario doesn't
/// have to coordinate with the score package directly.
export class ReplayEngine {
  private readonly tokens: Map<Address, TokenState> = new Map();
  private currentPhase: Phase;
  private readonly events: HarnessEvent[];

  constructor(
    events: ReadonlyArray<HarnessEvent>,
    private readonly config: HarnessConfig,
  ) {
    // Defensive copy + stable sort by ts (events with identical ts keep
    // input order — this matters when scenarios sequence "buy then sell at
    // the same ts" deliberately).
    this.events = [...events];
    this.events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    this.currentPhase = config.scoringConfig.phase;
  }

  run(): TickRecord[] {
    const events = this.events;
    if (events.length === 0) return [];

    const startTs = events[0]!.ts;
    const lastEventTs = events[events.length - 1]!.ts;
    const tickInterval = BigInt(this.config.tickGranularitySec);

    // Round endTickClock UP to the next tick boundary so the last event is
    // always observed by some tick.
    const span = lastEventTs - startTs;
    const ticksToEnd = (span + tickInterval - 1n) / tickInterval;
    const endTickClock = startTs + ticksToEnd * tickInterval;

    const records: TickRecord[] = [];
    let clock = startTs;
    let tickNum = 0;
    let eventIdx = 0;

    while (clock <= endTickClock) {
      // Apply all events at or before this tick boundary, in order.
      while (eventIdx < events.length && events[eventIdx]!.ts <= clock) {
        this.applyEvent(events[eventIdx]!);
        eventIdx++;
      }

      // Snapshot every live token (cheap if holders unchanged — see
      // TokenState.snapshot's dedupe).
      for (const t of this.tokens.values()) t.snapshot(clock);

      // Build cohort and score.
      const live: TokenState[] = [];
      for (const t of this.tokens.values()) if (t.isLive()) live.push(t);
      if (live.length > 0) {
        // Precompute LP metrics once per (token, tick) — both the scoring
        // input (avgLp + recentRemoved) and the raw output snapshot need
        // them, and each is an O(N_lp_events) scan, so caching here halves
        // the per-tick LP cost. Track E bulk replays will see this.
        const lpMetrics = new Map<Address, LpMetrics>();
        for (const t of live) {
          lpMetrics.set(t.token, {
            avgLp: t.avgLpDepthOver(clock, this.config.avgLpWindowSec),
            recentRemoved: t.recentLpRemovedOver(clock, this.config.recentLpWindowSec),
          });
        }
        const stats = live.map((t) =>
          this.buildTokenStats(t, clock, lpMetrics.get(t.token)!),
        );
        const scoringConfig: ScoringConfig = {
          ...this.config.scoringConfig,
          phase: this.currentPhase,
        };
        const scored = score(stats, clock, scoringConfig);
        for (const s of scored) {
          const state = this.tokens.get(s.token);
          if (state) state.priorBaseComposite = s.baseComposite;
          records.push(this.toRecord(s, clock, tickNum, lpMetrics.get(s.token)!));
        }
      }

      clock += tickInterval;
      tickNum++;
    }

    return records;
  }

  private applyEvent(ev: HarnessEvent): void {
    switch (ev.type) {
      case "LAUNCH": {
        if (this.tokens.has(ev.token)) {
          throw new Error(`harness: duplicate LAUNCH for ${ev.token}`);
        }
        const t = new TokenState(ev.token);
        if (ev.initialLpWeth > 0n) {
          t.applyLpAdd({type: "LP_ADD", ts: ev.ts, token: ev.token, amountWeth: ev.initialLpWeth, protocol: true});
        }
        this.tokens.set(ev.token, t);
        return;
      }
      case "BUY": {
        const t = this.requireToken(ev.token, "BUY");
        t.applyBuy(ev);
        return;
      }
      case "SELL": {
        const t = this.requireToken(ev.token, "SELL");
        t.applySell(ev);
        return;
      }
      case "LP_ADD": {
        const t = this.requireToken(ev.token, "LP_ADD");
        t.applyLpAdd(ev);
        return;
      }
      case "LP_REMOVE": {
        const t = this.requireToken(ev.token, "LP_REMOVE");
        t.applyLpRemove(ev);
        return;
      }
      case "TIME_ADVANCE": {
        // No state mutation — ts advances naturally via the outer loop.
        return;
      }
      case "PHASE": {
        this.currentPhase = ev.phase;
        return;
      }
    }
  }

  private requireToken(token: Address, eventType: string): TokenState {
    const t = this.tokens.get(token);
    if (!t) throw new Error(`harness: ${eventType} before LAUNCH for ${token}`);
    return t;
  }

  private buildTokenStats(t: TokenState, now: bigint, lp: LpMetrics): TokenStats {
    const longTs = now - BigInt(this.config.retentionAnchorLongSec);
    const longHolders = t.holdersAt(longTs);
    const currentHolders = t.holdersAt(now);
    const shortHolders = this.config.retentionAnchorShortSec > 0
      ? t.holdersAt(now - BigInt(this.config.retentionAnchorShortSec))
      : undefined;

    const stats: TokenStats = {
      token: t.token,
      volumeByWallet: t.volumeByWallet,
      buys: t.buys,
      sells: t.sells,
      liquidityDepthWeth: t.lpDepthWeth,
      avgLiquidityDepthWeth: lp.avgLp,
      recentLiquidityRemovedWeth: lp.recentRemoved,
      currentHolders,
      holdersAtRetentionAnchor: longHolders,
    };
    if (shortHolders) {
      // `holdersAtRecentAnchor` is optional on TokenStats; only attach when
      // the short window is configured.
      (stats as Mutable<TokenStats>).holdersAtRecentAnchor = shortHolders;
    }
    if (typeof t.priorBaseComposite === "number") {
      (stats as Mutable<TokenStats>).priorBaseComposite = t.priorBaseComposite;
    }
    return stats;
  }

  private toRecord(
    s: ScoredToken,
    clock: bigint,
    tickNum: number,
    lp: LpMetrics,
  ): TickRecord {
    const tsSec = Number(clock);
    const wall = new Date(this.config.startWallTimeMs + tsSec * 1000);
    const state = this.tokens.get(s.token)!;
    let totalVolume = 0n;
    for (const v of state.volumeByWallet.values()) totalVolume += v;
    const holderCount = state.holdersAt(clock).size;
    return {
      timestamp: wall.toISOString(),
      tsSec,
      tick: tickNum,
      tokenId: s.token.toLowerCase() as Address,
      // Epic 1.18: scoring returns integer HP in [0, 10000]. Tick records
      // surface the raw integer — downstream harness consumers (calibration
      // notebooks, replay reports) receive the same value the indexer
      // writes to hpSnapshot.
      hp: s.hp,
      phase: s.phase,
      components: {
        velocity: round4(s.components.velocity.score),
        effectiveBuyers: round4(s.components.effectiveBuyers.score),
        stickyLiquidity: round4(s.components.stickyLiquidity.score),
        retention: round4(s.components.retention.score),
        momentum: round4(s.components.momentum.score),
      },
      raw: {
        uniqueWallets: state.volumeByWallet.size,
        totalVolumeWeth: totalVolume.toString(),
        lpDepthWeth: state.lpDepthWeth.toString(),
        avgLpDepthWeth: lp.avgLp.toString(),
        recentLpRemovedWeth: lp.recentRemoved.toString(),
        holderCount,
      },
    };
  }
}

/// Per-(token, tick) LP metrics — precomputed once in `run()` and threaded
/// through both the scoring input and the raw output snapshot. See the
/// comment in `run()` for the rationale (avoids duplicate O(N_lp) scans).
interface LpMetrics {
  avgLp: bigint;
  recentRemoved: bigint;
}

type Mutable<T> = {-readonly [K in keyof T]: T[K]};

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
