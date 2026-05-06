"use client";

/// HP trajectory line chart for the graveyard detail page (Epic 1.25).
///
/// Renders the full hp-snapshot series for a filtered token as a SVG line.
/// Optional cut-line marker (dashed horizontal at `cutLineHp`) and peak
/// marker (filled circle at the highest point). Pure SVG — no chart library.

import {C, F} from "@/lib/tokens";

export type HpTrajectoryPoint = {timestamp: number; hp: number};

export type HpTrajectoryChartProps = {
  points: ReadonlyArray<HpTrajectoryPoint>;
  /// Cut-line HP — horizontal dashed line. Null hides it (pre-CUT season).
  cutLineHp?: number | null;
  /// Filter trigger timestamp — vertical dashed line at the filter moment.
  /// Null skips it.
  filteredAtSec?: number | null;
  /// Peak HP/timestamp — filled marker. Null skips it.
  peakHp?: number | null;
  peakAtSec?: number | null;
  width?: number;
  height?: number;
};

const HP_MAX = 10000;
const PADDING = {top: 16, right: 16, bottom: 24, left: 36};

export function HpTrajectoryChart({
  points,
  cutLineHp,
  filteredAtSec,
  peakHp,
  peakAtSec,
  width = 560,
  height = 200,
}: HpTrajectoryChartProps) {
  if (points.length === 0) {
    return (
      <div
        style={{
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: C.dim,
          fontFamily: F.mono,
          fontSize: 12,
        }}
      >
        No HP samples indexed.
      </div>
    );
  }

  const innerW = width - PADDING.left - PADDING.right;
  const innerH = height - PADDING.top - PADDING.bottom;

  // X domain = [first sample, last sample]. Y domain = [0, HP_MAX] (Epic 1.18
  // composite scale). We don't auto-fit Y so the cut line + peak read at
  // consistent positions across charts.
  const tMin = points[0]?.timestamp ?? 0;
  const tMax = points[points.length - 1]?.timestamp ?? tMin;
  const tSpan = Math.max(1, tMax - tMin);

  const x = (t: number): number =>
    PADDING.left + ((t - tMin) / tSpan) * innerW;
  const y = (hp: number): number =>
    PADDING.top + innerH - (Math.max(0, Math.min(HP_MAX, hp)) / HP_MAX) * innerH;

  // Build the line path.
  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.timestamp).toFixed(2)} ${y(p.hp).toFixed(2)}`)
    .join(" ");

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="HP trajectory"
    >
      {/* Y-axis ticks at 0, 5000, 10000 — frames the integer scale. */}
      {[0, 5000, 10000].map((tick) => (
        <g key={tick}>
          <line
            x1={PADDING.left}
            y1={y(tick)}
            x2={width - PADDING.right}
            y2={y(tick)}
            stroke={C.lineSoft}
            strokeWidth={1}
          />
          <text
            x={PADDING.left - 6}
            y={y(tick) + 3}
            textAnchor="end"
            fontFamily={F.mono}
            fontSize={10}
            fill={C.dim}
          >
            {tick}
          </text>
        </g>
      ))}

      {/* Cut-line marker (dashed horizontal). */}
      {cutLineHp !== null && cutLineHp !== undefined ? (
        <g>
          <line
            x1={PADDING.left}
            y1={y(cutLineHp)}
            x2={width - PADDING.right}
            y2={y(cutLineHp)}
            stroke={C.red}
            strokeWidth={1.5}
            strokeDasharray="4 4"
            opacity={0.6}
          />
          <text
            x={width - PADDING.right - 4}
            y={y(cutLineHp) - 4}
            textAnchor="end"
            fontFamily={F.mono}
            fontSize={10}
            fill={C.red}
          >
            cut line {cutLineHp}
          </text>
        </g>
      ) : null}

      {/* Filter-moment marker (vertical dashed). */}
      {filteredAtSec !== null && filteredAtSec !== undefined ? (
        <line
          x1={x(filteredAtSec)}
          y1={PADDING.top}
          x2={x(filteredAtSec)}
          y2={height - PADDING.bottom}
          stroke={C.red}
          strokeWidth={1.5}
          strokeDasharray="3 3"
          opacity={0.45}
        />
      ) : null}

      {/* HP line. */}
      <path d={pathD} fill="none" stroke={C.cyan} strokeWidth={1.6} />

      {/* Peak marker. */}
      {peakHp !== null && peakHp !== undefined && peakAtSec !== null && peakAtSec !== undefined ? (
        <g>
          <circle cx={x(peakAtSec)} cy={y(peakHp)} r={4} fill={C.yellow} />
          <text
            x={x(peakAtSec) + 8}
            y={y(peakHp) + 3}
            fontFamily={F.mono}
            fontSize={10}
            fill={C.yellow}
          >
            peak {peakHp}
          </text>
        </g>
      ) : null}
    </svg>
  );
}
