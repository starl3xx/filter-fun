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

import {hpAsInt100, tickerWithDollar} from "../builders.js";
import {errName, redactErrorMessage} from "./redact.js";
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
  /// Per-tick locker→token resolution map. The fee-accrual schema stores LOCKER
  /// addresses (FilterLpLocker is the FeesCollected emitter), but detectors look up by
  /// token contract address. Returning the map from queries lets the engine fetch the
  /// token table once per tick and share it between `recentFees` and `baselineFees`.
  tokenAddressByLocker: () => Promise<Map<string, `0x${string}`>>;
  /// Fee accruals since `sinceSec` for the volume-spike + large-trade detectors. Each row
  /// is one `FeesCollected` event from the indexer schema, with locker addresses already
  /// resolved to token contract addresses via `lockerMap`.
  recentFees: (
    sinceSec: bigint,
    lockerMap: ReadonlyMap<string, `0x${string}`>,
  ) => Promise<FeeAccrualRow[]>;
  /// Trailing-baseline fees per token over `[sinceSec - baselineWindow, sinceSec]`. Used
  /// as the volume-spike denominator.
  baselineFees: (
    sinceSec: bigint,
    baselineWindowSec: bigint,
    lockerMap: ReadonlyMap<string, `0x${string}`>,
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
  /// Re-entry guard. `setInterval` doesn't await the async callback, so a slow tick can
  /// be lapped by the next interval firing. Without this, two `tick()` calls overlap and
  /// step on each other's `prevSnapshot` reads / writes — fees queried against one prev,
  /// detectors run against another. We just skip the lap; the next tick picks back up.
  private inFlight = false;
  private nowFn: () => number;

  constructor(private opts: TickEngineOpts) {
    this.cfg = opts.cfg ?? loadConfigFromEnv();
    this.nowFn = opts.now ?? (() => Date.now());
  }

  /// Run a single tick — pulls a snapshot, diffs, broadcasts. Returns the broadcast
  /// payload (also useful for tests).
  async tick(): Promise<{snapshot: Snapshot | null; emitted: number}> {
    if (this.inFlight) return {snapshot: null, emitted: 0};
    this.inFlight = true;
    try {
      // Capture once at the top — `this.prevSnapshot` is read across multiple await
      // points (fee queries + detectors), and even with the in-flight guard we want a
      // single coherent reference so the `sinceSec` we queried fees against is the same
      // snapshot we feed `diffSnapshots`.
      const prev = this.prevSnapshot;

      const seasonRow = await this.opts.queries.latestSeason();
      if (!seasonRow) return {snapshot: null, emitted: 0};

      const tokens = await this.opts.queries.tokensForSnapshot(seasonRow.seasonId);

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
          ticker: tickerWithDollar(t.symbol),
          rank,
          hp: hpAsInt100(s?.hp ?? 0),
          isFinalist: t.isFinalist,
          liquidated: t.liquidated,
        };
      });

      const nextCutAtSec = nextCutEpochSec(seasonRow.startedAtSec, apiPhase);
      // Audit I-Indexer-2 (Phase 1, 2026-05-01): `takenAtSec` here is the
      // wall-clock at QUERY time (captured by the `latestSeason` query), not the
      // wall-clock at snapshot-assembly time. For tick cadences in the seconds
      // (`tickMs` defaults to 5_000), the gap between the query return and this
      // assembly is sub-millisecond; for genuinely slow ticks (DB stall, GC pause,
      // event loop saturation) the value drifts late by however long the gap was.
      // The detectors that consume this snapshot key off the DELTA between
      // consecutive `takenAtSec` values, so a uniformly-late capture remains
      // self-consistent — only an ASYMMETRIC delay (one tick slow, the next fast)
      // would skew detector windowing. Acceptable for the genesis tick rate;
      // re-evaluate if `tickMs` ever moves into the multi-second range.
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
      if (prev) {
        const sinceSec = prev.takenAtSec;
        // Locker→token map, fetched once per tick and shared between both fee queries.
        // The token table changes only when a new token launches (rare); fetching twice
        // per 5s tick was strictly duplicate work.
        const lockerMap = await this.opts.queries.tokenAddressByLocker();
        recentFees = await this.opts.queries.recentFees(sinceSec, lockerMap);
        // Baseline window: the previous full window of equal length, i.e. [sinceSec - delta, sinceSec).
        const delta = current.takenAtSec - sinceSec;
        const baselineByAddr = await this.opts.queries.baselineFees(sinceSec, delta, lockerMap);
        baseline = new Map(
          [...baselineByAddr.entries()].map(([k, v]) => [k.toLowerCase(), v]),
        );
      }

      const detected = diffSnapshots(prev, current, recentFees, baseline, this.cfg);

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
    } finally {
      this.inFlight = false;
    }
  }

  /// Start the periodic tick. Idempotent — calling twice is a no-op. The SSE route owns
  /// its own heartbeat keepalive (driven by `cfg.heartbeatMs`); the engine doesn't run
  /// one here.
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        // Indexer DB hiccups shouldn't crash the events stream — log + carry on.
        // Errors arrive on the next tick after the underlying issue resolves.
        // Audit M-Indexer-6 (Phase 1, 2026-05-01): switched from a bare `console.error`
        // string to a structured single-line JSON record. The PII risk comes from the
        // exception's `message` (which can quote query parameters or address values
        // depending on the underlying error type). Routing through `redactErrorMessage`
        // strips wallet-shaped strings before they reach the log sink. Keeping the sink
        // as `console.error` avoids adding a pino dep just for this one site; downstream
        // log forwarders (Railway / Datadog) auto-parse single-line JSON when a
        // `level` field is present, so the structure is preserved.
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({
          level: "error",
          source: "events.tick",
          message: redactErrorMessage(err),
          name: errName(err),
        }));
      });
    }, this.cfg.tickMs);
    // Don't keep the process alive just for this loop.
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as {unref: () => void}).unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /// Audit H-4 (Phase 1, 2026-05-01): the /readiness probe reads this to gate "is the
  /// indexer actually serving real-time data?" The engine is healthy iff `start()` has
  /// been called AND `stop()` hasn't been; the timer field is the canonical signal.
  isRunning(): boolean {
    return this.timer !== null;
  }
}

