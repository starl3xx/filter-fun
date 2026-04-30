/// Type definitions shared across the events module.
///
/// Three layers:
///   1. `TokenSnapshot` / `Snapshot`     — what the tick engine pulls from the DB each tick
///   2. `DetectedEvent`                  — what the detectors emit (raw, no message yet)
///   3. `TickerEvent`                    — final wire format the pipeline emits to clients
///
/// Each layer is distinct on purpose: detectors stay focused on *what changed*, the
/// message renderer stays focused on *how to phrase it*, and the wire format stays small
/// and stable for downstream consumers (Epic 1.8 ticker UI).

export type EventPriority = "HIGH" | "MEDIUM" | "LOW";

/// Event types emitted by `/events`. The set is closed; new types should be added here so
/// downstream consumers can pattern-match exhaustively. Mirrors spec §26.3 + §36.1.4.
export type EventType =
  | "RANK_CHANGED"        // any rank delta within the cohort (MEDIUM, throttled)
  | "CUT_LINE_CROSSED"    // rank crossed position 6 (HIGH)
  | "HP_SPIKE"            // |Δhp| ≥ threshold across one tick (MEDIUM)
  | "VOLUME_SPIKE"        // current-window volume / baseline ≥ ratio (MEDIUM)
  | "LARGE_TRADE"         // single trade ≥ threshold (LOW unless near cut)
  | "FILTER_FIRED"        // contract emitted Filter phase / liquidation (HIGH)
  | "FILTER_COUNTDOWN"    // < N min until filter (HIGH)
  | "PHASE_ADVANCED";     // any season phase advance (MEDIUM)

export interface TokenSnapshot {
  address: `0x${string}`;
  ticker: string; // already prefixed with `$`
  rank: number;   // 0 = unscored
  hp: number;     // 0–100 wire format
  isFinalist: boolean;
  liquidated: boolean;
}

export interface Snapshot {
  takenAtSec: bigint;
  seasonId: bigint;
  phase: string; // contract-level phase string ("Launch" / "Filter" / etc.)
  /// Wall-clock seconds at which the next cut is expected. Sourced from
  /// `phase.nextCutEpochSec(season, phase)` which derives from `season.startedAt` plus
  /// the spec §36.1.5 phase offsets. Used by the FILTER_COUNTDOWN detector. `null` when
  /// no cut is upcoming (settled / closed phases).
  nextCutAtSec: bigint | null;
  tokens: ReadonlyArray<TokenSnapshot>;
}

export interface FeeAccrualRow {
  /// Locker address — maps back to a token via the indexer schema's locker→token relation.
  /// For events, we only need it to attribute trades to a token, so callers resolve to
  /// `address` before passing to detectors.
  tokenAddress: `0x${string}`;
  /// Sum of all three slices for the row, in WETH wei. Drives both volume-spike and
  /// large-trade detection. Inferring trade size from this requires `tradeFeeBps` config.
  totalFeeWei: bigint;
  blockTimestampSec: bigint;
}

/// A change observed by a detector. Detector outputs are pure "the world ticked, here's
/// what changed" objects. The pipeline + message renderer turn these into wire events.
export interface DetectedEvent {
  type: EventType;
  /// Source token if event is token-scoped. `null` means a system-level event
  /// (FILTER_FIRED, PHASE_ADVANCED on the season as a whole, FILTER_COUNTDOWN).
  token: TokenSnapshot | null;
  /// Type-specific payload. Surfaced in the wire `data` field verbatim.
  data: Record<string, unknown>;
  /// Override priority — most types pin to a constant priority via `priorityOf`, but
  /// detectors can elevate (e.g. a LARGE_TRADE near the cut line becomes MEDIUM).
  priorityOverride?: EventPriority;
}

/// Wire-format event delivered to SSE clients. JSON-serializable.
export interface TickerEvent {
  /// Monotonic per-process id. Doubles as the SSE `id:` field so clients can use
  /// `Last-Event-ID` to know how far they've already consumed (server keeps no replay
  /// buffer — clients reconnect with the latest id they saw).
  id: number;
  type: EventType;
  priority: EventPriority;
  /// `$TICKER` for token-scoped events, `null` for system events.
  token: string | null;
  /// `0x…` token address for token-scoped events, `null` for system events.
  address: `0x${string}` | null;
  /// Human-readable copy for the ticker (already includes any icon glyph).
  message: string;
  /// Type-specific structured fields the UI may want to render distinctly (e.g.
  /// `fromRank`, `toRank` on RANK_CHANGED so the UI can pick an arrow direction).
  data: Record<string, unknown>;
  /// ISO8601, server-side wall clock at emission.
  timestamp: string;
}
