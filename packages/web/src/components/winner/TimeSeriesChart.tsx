"use client";

/// Generic time-series line chart used by the winner detail page (Epic 1.26).
///
/// Renders one or two parallel series (e.g. activeHolders vs fromOriginal,
/// reserveWeth alone, creatorEarnedWeth + polTopUpWeth). Pure SVG; the
/// responsiveness is delegated to the SVG viewBox.

import {C, F} from "@/lib/tokens";

export type TimeSeriesPoint = {timestamp: number; value: number};

export type TimeSeriesChartProps = {
  primary: ReadonlyArray<TimeSeriesPoint>;
  /// Optional secondary series rendered in a contrasting color. Same x-axis;
  /// timestamps don't have to align (each series is independently sampled).
  secondary?: ReadonlyArray<TimeSeriesPoint>;
  /// Color tokens for primary + secondary (defaults to cyan + yellow).
  primaryColor?: string;
  secondaryColor?: string;
  /// Y-axis label suffix (e.g. " WETH", " holders").
  unitLabel?: string;
  width?: number;
  height?: number;
};

const PADDING = {top: 16, right: 16, bottom: 24, left: 48};

export function TimeSeriesChart({
  primary,
  secondary,
  primaryColor = C.cyan,
  secondaryColor = C.yellow,
  unitLabel = "",
  width = 560,
  height = 200,
}: TimeSeriesChartProps) {
  const all = [...primary, ...(secondary ?? [])];
  if (all.length === 0) {
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
        No data yet.
      </div>
    );
  }

  const innerW = width - PADDING.left - PADDING.right;
  const innerH = height - PADDING.top - PADDING.bottom;

  const tMin = Math.min(...all.map((p) => p.timestamp));
  const tMax = Math.max(...all.map((p) => p.timestamp));
  const tSpan = Math.max(1, tMax - tMin);

  const vMin = 0;
  const vMax = Math.max(1, ...all.map((p) => p.value));

  const x = (t: number): number =>
    PADDING.left + ((t - tMin) / tSpan) * innerW;
  const y = (v: number): number =>
    PADDING.top + innerH - ((v - vMin) / (vMax - vMin)) * innerH;

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="time series chart"
    >
      {/* Y ticks at 0 / mid / max. */}
      {[0, vMax / 2, vMax].map((tick, i) => (
        <g key={i}>
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
            {formatTickValue(tick)}
            {unitLabel}
          </text>
        </g>
      ))}

      {/* Primary line + dots. */}
      <Series points={primary} x={x} y={y} color={primaryColor} />
      {secondary && secondary.length > 0 ? (
        <Series points={secondary} x={x} y={y} color={secondaryColor} dashed />
      ) : null}
    </svg>
  );
}

function Series({
  points,
  x,
  y,
  color,
  dashed,
}: {
  points: ReadonlyArray<TimeSeriesPoint>;
  x: (t: number) => number;
  y: (v: number) => number;
  color: string;
  dashed?: boolean;
}) {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
  const pathD = sorted
    .map(
      (p, i) => `${i === 0 ? "M" : "L"} ${x(p.timestamp).toFixed(2)} ${y(p.value).toFixed(2)}`,
    )
    .join(" ");
  return (
    <g>
      <path
        d={pathD}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeDasharray={dashed ? "4 4" : undefined}
      />
      {sorted.map((p, i) => (
        <circle key={i} cx={x(p.timestamp)} cy={y(p.value)} r={2.5} fill={color} />
      ))}
    </g>
  );
}

function formatTickValue(v: number): string {
  if (v === 0) return "0";
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.001) return v.toFixed(4);
  return v.toExponential(1);
}
