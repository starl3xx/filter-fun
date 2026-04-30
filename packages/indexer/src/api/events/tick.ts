/// Tick engine — pulls a snapshot from the DB on a fixed cadence, runs detectors, runs
/// the pipeline, and broadcasts emitted events to all subscribers.
///
/// The DB-touching part is hidden behind `EventsQueries`, exactly the same pattern as
/// part 1's `ApiQueries` — the route file plugs in a Drizzle-backed implementation, tests
/// drive it with fixture queries.
///
/// State lives at module level inside this engine: previous snapshot, pipeline state,
/// monotonic event id. There's exactly one engine per process; horizontally scaling the
/// indexer would mean moving this state to redis pub/sub (out of scope for genesis).

import {scoreCohort} from "../hp.js";
import {nextCutEpochSec, toApiPhase} from "../phase.js";

import {loadConfigFromEnv, type EventsConfig} from "./config.js";
import {diffSnapshots} from "./detectors.js";
import {Hub} from "./hub.js";
import {makeState, runPipeline, type PipelineClock, type PipelineState} from "./pipeline.js";
import type {FeeAccrualRow, Snapshot, TokenSnapshot} from "./types.js";

export interface EventsQueries {
  /// Latest season metadata + the contract-level phase string. Returns null if no season
  /// has been indexed yet. `startedAt` drives next-cut math for the FILTER_COUNTDOWN
  /// detector; `takenAtSec` is the wall-clock at which this snapshot is being constructed.
  latestSeason: () => Promise<{
    seasonId: bigint;
    phase: string;
    startedAtSec: bigint;
    takenAtSec: bigint;
  } | null>;
  /// Tokens for `seasonId`, with the columns needed for HP composition + status.
  tokensForSnapshot: (seasonId: bigint) => Promise<
    Array<{
      address: `0x${string}`;
      symbol: string;
      isFinalist: boolean;
      liquidated: boolean;
      liquidationProceeds: bigint | null;
    }>
  >;
  /// Cumulative fee accruals per token across the lifetime of the season — used to seed
  /// the snapshot's `cumulativeFeeWei`. Differencing across snapshots gives per-tick
  /// trading volume for the volume-spike + large-trade detectors.
  cumulativeFeesByToken: (seasonId: bigint) => Promise<Map<`0x${string}`, bigint>>;
  /// Fee accruals since `sinceSec` for the volume-spike + large-trade detectors. Each row
  /// is one `FeesCollected` event from the indexer schema.
  recentFees: (sinceSec: bigint) => Promise<FeeAccrualRow[]>;
  /// Trailing-baseline fees per token over `[sinceSec - baselineWindow, sinceSec]`. Used
  /// as the volume-spike denominator.
  baselineFees: (
    sinceSec: bigint,
    baselineWindowSec: bigint,
  ) => Promise<Map<`0x${string}`, bigint>>;
}

export interface TickEngineOpts {
  cfg?: EventsConfig;
  /// Override the wall-clock — used by tests. `now()` returns ms since epoch.
  now?: () => number;
  /// Queries adapter.
  queries: EventsQueries;
  /// Hub to broadcast into.
  hub: Hub;
}

export class TickEngine {
  readonly cfg: EventsConfig;
  private prevSnapshot: Snapshot | null = null;
  private pipelineState: PipelineState = makeState();
  private nextEventId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private nowFn: () => number;

  constructor(private opts: TickEngineOpts) {
    this.cfg = opts.cfg ?? loadConfigFromEnv();
    this.nowFn = opts.now ?? (() => Date.now());
  }

  /// Run a single tick — pulls a snapshot, diffs, broadcasts. Returns the broadcast
  /// payload (also useful for tests).
  async tick(): Promise<{snapshot: Snapshot | null; emitted: number}> {
    const seasonRow = await this.opts.queries.latestSeason();
    if (!seasonRow) return {snapshot: null, emitted: 0};

    const tokens = await this.opts.queries.tokensForSnapshot(seasonRow.seasonId);
    const cumulativeFees = await this.opts.queries.cumulativeFeesByToken(seasonRow.seasonId);

    const apiPhase = toApiPhase(seasonRow.phase);
    const scored = scoreCohort(
      tokens.map((t) => ({id: t.address, liquidationProceeds: t.liquidationProceeds})),
      apiPhase,
      seasonRow.takenAtSec,
    );

    const snapshotTokens: TokenSnapshot[] = tokens.map((t) => {
      const s = scored.get(t.address.toLowerCase());
      const rank = s?.rank ?? 0;
      return {
        address: t.address,
        ticker: t.symbol.startsWith("$") ? t.symbol : `$${t.symbol}`,
        rank,
        hp: hpAsInt100(s?.hp ?? 0),
        isFinalist: t.isFinalist,
        liquidated: t.liquidated,
        cumulativeFeeWei: cumulativeFees.get(t.address.toLowerCase() as `0x${string}`) ?? 0n,
      };
    });

    const nextCutAtSec = nextCutEpochSec(seasonRow.startedAtSec, apiPhase);
    const current: Snapshot = {
      takenAtSec: seasonRow.takenAtSec,
      seasonId: seasonRow.seasonId,
      phase: seasonRow.phase,
      nextCutAtSec,
      tokens: snapshotTokens,
    };

    // Pull the recent-fees window + baseline only after we have a previous snapshot —
    // detectors return [] on the first tick so we'd be wasting queries.
    let recentFees: FeeAccrualRow[] = [];
    let baseline = new Map<string, bigint>();
    if (this.prevSnapshot) {
      const sinceSec = this.prevSnapshot.takenAtSec;
      recentFees = await this.opts.queries.recentFees(sinceSec);
      // Baseline window: the previous full window of equal length, i.e. [sinceSec - delta, sinceSec).
      const delta = current.takenAtSec - sinceSec;
      const baselineByAddr = await this.opts.queries.baselineFees(sinceSec, delta);
      baseline = new Map(
        [...baselineByAddr.entries()].map(([k, v]) => [k.toLowerCase(), v]),
      );
    }

    const detected = diffSnapshots(this.prevSnapshot, current, recentFees, baseline, this.cfg);

    const clock: PipelineClock = {
      nowMs: this.nowFn,
      now: () => {
        const id = this.nextEventId++;
        return {iso: new Date(this.nowFn()).toISOString(), id};
      },
    };
    const result = runPipeline(detected, this.pipelineState, this.cfg, clock);
    this.opts.hub.broadcast(result.emitted);

    this.prevSnapshot = current;
    return {snapshot: current, emitted: result.emitted.length};
  }

  /// Start the periodic tick + heartbeat. Idempotent — calling twice is a no-op.
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        // Indexer DB hiccups shouldn't crash the events stream — log + carry on.
        // Errors arrive on the next tick after the underlying issue resolves.
        // eslint-disable-next-line no-console
        console.error("[events.tick] error:", err);
      });
    }, this.cfg.tickMs);
    // Don't keep the process alive just for this loop.
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as {unref: () => void}).unref();
    }

    // Heartbeat tick — broadcasts an empty array which the SSE route uses as a signal to
    // emit the SSE comment line. Hub intentionally doesn't broadcast empty arrays, so the
    // route reads `cfg.heartbeatMs` directly and emits its own keepalives.
    // (No-op here; left as a hook so future versions can attach a real heartbeat event.)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

function hpAsInt100(hp01: number): number {
  if (!Number.isFinite(hp01)) return 0;
  const clamped = Math.max(0, Math.min(1, hp01));
  return Math.round(clamped * 100);
}
