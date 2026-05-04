/// Slim HP bar — status-driven gradient (ARENA_SPEC §6.4.3) with the integer
/// `[0, HP_MAX]` value next to it. Distinct from the broadcast `HpBar` (which
/// renders an interactive tooltip with component breakdown) — that lives on
/// the broadcast home and reads simulated component data; this one renders
/// from the live `/tokens` integer HP.
///
/// Epic 1.18 — composite scale flipped from `[0, 100]` to `[0, 10000]`. The
/// bar's gradient still scales by the same fraction; only the displayed
/// number and the aria-valuemax changed.
///
/// Audit H-Arena-2 (Phase 1, 2026-05-01): pre-fix the bar derived a single fill
/// colour from HP value alone, ignoring the row's status. The spec gradient is
/// intentional — finalist/safe/risk read at-a-glance from the bar's hue, not its
/// length. The HP-bucket colorForHp() helper is retained as a fallback for callers
/// that don't (yet) have a status on hand.
import type {TokenStatus} from "@/lib/arena/api";
import {HP_BUCKETS, HP_MAX} from "@/lib/arena/hp";
import {C, F} from "@/lib/tokens";

export type ArenaHpBarProps = {
  /// Integer in `[0, HP_MAX]` (= [0, 10000]) — Epic 1.18 composite scale.
  hp: number;
  /// Status drives the bar gradient + (when finalist) the value glow. Optional
  /// because a few legacy callers don't yet have it; absent → fall back to the
  /// HP-bucket colour spectrum.
  status?: TokenStatus;
  /// Width in px. Defaults match the leaderboard column.
  width?: number;
  /// Show the numeric value next to the bar.
  showValue?: boolean;
  /// Dim treatment — applied to filtered / below-cut rows.
  dim?: boolean;
};

/// ARENA_SPEC §6.4.3 — status → [from, to] gradient stops. FILTERED reuses the
/// AT_RISK red→pink so the bar still reads the same urgency hue post-cut.
export const STATUS_GRADIENT: Record<TokenStatus, readonly [string, string]> = {
  FINALIST: [C.yellow, C.pink],
  SAFE: [C.green, C.cyan],
  AT_RISK: [C.red, C.pink],
  FILTERED: [C.red, C.pink],
} as const;

export function ArenaHpBar({hp, status, width = 100, showValue = true, dim}: ArenaHpBarProps) {
  const clamped = Math.max(0, Math.min(HP_MAX, hp));
  // Bar fill is a percentage of the full range — same visual ratio under
  // the int10k scale as it was under the prior 0-100 scale.
  const fillPct = (clamped / HP_MAX) * 100;
  const [fromColor, toColor] = status
    ? STATUS_GRADIENT[status]
    : fallbackGradientForHp(clamped);
  const finalist = status === "FINALIST";
  return (
    <div style={{display: "flex", alignItems: "center", gap: 8, opacity: dim ? 0.55 : 1}}>
      <div
        aria-label={`HP ${clamped} of ${HP_MAX}`}
        role="meter"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={HP_MAX}
        style={{
          position: "relative",
          width,
          height: 6,
          borderRadius: 99,
          background: "rgba(255,255,255,0.06)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            bottom: 0,
            width: `${fillPct}%`,
            background: `linear-gradient(90deg, ${fromColor}, ${toColor})`,
            boxShadow: `0 0 6px ${fromColor}66`,
            transition: "width 0.4s ease",
          }}
        />
      </div>
      {showValue && (
        <span
          style={{
            fontSize: 11,
            fontFamily: F.mono,
            fontWeight: 700,
            color: dim ? C.faint : C.dim,
            fontVariantNumeric: "tabular-nums",
            // The integer width grew from 3 chars (0-100) to 5 chars (0-10000);
            // bump min-width so right-aligned values don't shift the layout.
            minWidth: 36,
            textAlign: "right",
            textShadow: finalist && !dim ? `0 0 8px ${C.yellow}66` : undefined,
          }}
        >
          {clamped}
        </span>
      )}
    </div>
  );
}

/// HP-bucket fallback for callers that don't pass `status`. Buckets are
/// expressed against the integer `[0, HP_MAX]` scale (Epic 1.18) — same
/// fractions as the prior 0-100 buckets. Thresholds live in `HP_BUCKETS`
/// in `lib/arena/hp.ts` so a future tuning pass changes one place, not
/// two (bugbot finding Low on PR #89).
export function colorForHp(hp: number): string {
  if (hp >= HP_BUCKETS.cyanFloor) return C.cyan;
  if (hp >= HP_BUCKETS.greenFloor) return C.green;
  if (hp >= HP_BUCKETS.amberFloor) return "#ffa940";
  return C.red;
}

function fallbackGradientForHp(hp: number): readonly [string, string] {
  const c = colorForHp(hp);
  return [c, `${c}cc`] as const;
}
