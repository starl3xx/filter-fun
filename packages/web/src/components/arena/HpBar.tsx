/// Slim HP bar — segmented gradient from low (red) to high (cyan) with the
/// integer 0–100 value next to it. Distinct from the broadcast `HpBar` (which
/// renders an interactive tooltip with component breakdown) — that lives on
/// the broadcast home and reads simulated component data; this one renders
/// from the live `/tokens` HP integer.

import {C, F} from "@/lib/tokens";

export type ArenaHpBarProps = {
  /// 0-100 integer.
  hp: number;
  /// Width in px. Defaults match the leaderboard column.
  width?: number;
  /// Show the numeric value next to the bar.
  showValue?: boolean;
  /// Dim treatment — applied to filtered / below-cut rows.
  dim?: boolean;
};

export function ArenaHpBar({hp, width = 100, showValue = true, dim}: ArenaHpBarProps) {
  const clamped = Math.max(0, Math.min(100, hp));
  const color = colorForHp(clamped);
  return (
    <div style={{display: "flex", alignItems: "center", gap: 8, opacity: dim ? 0.55 : 1}}>
      <div
        aria-label={`HP ${clamped} of 100`}
        role="meter"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
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
            width: `${clamped}%`,
            background: `linear-gradient(90deg, ${color}, ${color}cc)`,
            boxShadow: `0 0 6px ${color}66`,
            transition: "width 0.4s ease",
          }}
        />
      </div>
      {showValue && (
        <span style={{fontSize: 11, fontFamily: F.mono, fontWeight: 700, color: dim ? C.faint : C.dim, fontVariantNumeric: "tabular-nums", minWidth: 22, textAlign: "right"}}>
          {clamped}
        </span>
      )}
    </div>
  );
}

export function colorForHp(hp: number): string {
  if (hp >= 75) return C.cyan;
  if (hp >= 50) return C.green;
  if (hp >= 30) return "#ffa940";
  return C.red;
}
