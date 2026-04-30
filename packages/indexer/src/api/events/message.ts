/// Message + priority renderer.
///
/// Takes a `DetectedEvent` and produces the wire-format `TickerEvent` (priority pinned,
/// human-readable message composed). Kept separate from `detectors.ts` so the detection
/// logic can stay focused on "what changed" and message wording can iterate without
/// touching diff math.
///
/// Message style follows spec §20 examples:
///   - Token name always `$`-prefixed.
///   - Direction symbols inline (↑ ↓ 🔻 🔥 🐋 🏆) — Epic 1.8's ticker UI renders unicode
///     directly per spec §20.9.
///   - Concrete numbers ("$EDGE +18 HP", "$KING buy Ξ3.1") so the line carries information
///     even without UI styling.

import type {DetectedEvent, EventPriority, TickerEvent} from "./types.js";

/// Priority lookup. `LARGE_TRADE` is the only type that meaningfully differs from its
/// default — a trade near the cut line elevates from LOW to MEDIUM via
/// `priorityOverride`. Otherwise the type → priority map is fixed (spec §36.1.4).
const PRIORITY_BY_TYPE: Record<DetectedEvent["type"], EventPriority> = {
  CUT_LINE_CROSSED: "HIGH",
  FILTER_FIRED: "HIGH",
  FILTER_COUNTDOWN: "HIGH",
  RANK_CHANGED: "MEDIUM",
  HP_SPIKE: "MEDIUM",
  VOLUME_SPIKE: "MEDIUM",
  PHASE_ADVANCED: "MEDIUM",
  LARGE_TRADE: "LOW",
};

export function priorityOf(d: DetectedEvent): EventPriority {
  return d.priorityOverride ?? PRIORITY_BY_TYPE[d.type];
}

export interface RendererClock {
  /// Returns wall-clock ISO8601 + monotonic id. Injected so tests can pin both.
  now: () => {iso: string; id: number};
}

export function renderEvent(d: DetectedEvent, clock: RendererClock): TickerEvent {
  const {iso, id} = clock.now();
  const priority = priorityOf(d);
  const token = d.token?.ticker ?? null;
  const address = d.token?.address ?? null;
  return {
    id,
    type: d.type,
    priority,
    token,
    address,
    message: composeMessage(d),
    data: d.data,
    timestamp: iso,
  };
}

/// Crafts the human-readable line. Falls through to a generic format on unknown types so
/// adding a detector type doesn't accidentally suppress the event from the stream.
function composeMessage(d: DetectedEvent): string {
  const t = d.token?.ticker ?? "";
  switch (d.type) {
    case "CUT_LINE_CROSSED": {
      const direction = (d.data.direction as "above" | "below" | undefined) ?? "below";
      return direction === "above"
        ? `${t} just climbed above the cut line ↑`
        : `${t} just dropped below the cut line 🔻`;
    }
    case "RANK_CHANGED": {
      const from = Number(d.data.fromRank);
      const to = Number(d.data.toRank);
      const arrow = to < from ? "↑" : "↓";
      return `${t} ${arrow} rank ${from} → ${to}`;
    }
    case "HP_SPIKE": {
      const delta = Number(d.data.hpDelta);
      const sign = delta >= 0 ? "+" : "";
      return `${t} ${sign}${delta} HP 🔥`;
    }
    case "VOLUME_SPIKE": {
      const ratio = d.data.ratio === null ? "∞" : `${(Number(d.data.ratio) * 100).toFixed(0)}%`;
      return `${t} volume spike ${ratio} of baseline`;
    }
    case "LARGE_TRADE": {
      const eth = weiToShortEth(BigInt(String(d.data.tradeWei ?? 0)));
      const whale = (d.data.nearCutLine as boolean) ? "🐋 " : "";
      return `${whale}${t} trade Ξ${eth}`;
    }
    case "FILTER_FIRED":
      return `🔻 ${t} has been filtered`;
    case "FILTER_COUNTDOWN": {
      const minutes = Number(d.data.minutesUntilCut ?? 0);
      return `🔻 Filter in ${minutes}m`;
    }
    case "PHASE_ADVANCED":
      return `Phase advanced → ${String(d.data.toPhase ?? "?")}`;
    default:
      return `${t}`.trim() || "event";
  }
}

/// Compact-Ξ formatter: 3 decimal places, trimmed. Matches spec §20.6 examples
/// (`Ξ3.1`, `Ξ1.2`).
function weiToShortEth(wei: bigint): string {
  if (wei === 0n) return "0";
  const whole = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  if (frac === 0n) return whole.toString();
  // 3-decimal rounding.
  const scale = 10n ** 15n;
  const halfScale = scale / 2n;
  let frac3 = (frac + halfScale) / scale;
  let carryWhole = whole;
  if (frac3 >= 1000n) {
    carryWhole += 1n;
    frac3 = 0n;
  }
  if (frac3 === 0n) return carryWhole.toString();
  const fracStr = frac3.toString().padStart(3, "0").replace(/0+$/, "");
  return `${carryWhole.toString()}.${fracStr}`;
}
