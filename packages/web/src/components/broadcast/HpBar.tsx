"use client";

import {useEffect, useId, useRef, useState, type CSSProperties} from "react";
import {createPortal} from "react-dom";

import {fmtNum} from "@/lib/format";
import type {Token} from "@/lib/seed";
import {C, F} from "@/lib/tokens";

type Props = {token: Token; below?: boolean; finalist?: boolean};

const COMPONENT_ORDER: Array<keyof Token["components"]> = [
  "velocity",
  "effectiveBuyers",
  "stickyLiquidity",
  "retention",
  "momentum",
];

const TOOLTIP_WIDTH = 260;
const TOOLTIP_GAP = 8;

// HP bar with hover/focus tooltip showing the 5-component breakdown. The
// tooltip is rendered to document.body via portal with viewport-relative
// coordinates so it isn't clipped by the leaderboard's scroll/overflow
// container.
export function HpBar({token, below, finalist}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{top: number; left: number} | null>(null);
  const tooltipId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const barFill = below
    ? `linear-gradient(90deg, ${C.red}, ${C.pink})`
    : finalist
      ? `linear-gradient(90deg, ${C.yellow}, ${C.pink})`
      : `linear-gradient(90deg, ${C.cyan}, ${C.purple})`;
  const glow = below ? C.red : C.cyan;

  // Estimate tooltip height (5 component rows + header + footer). Used only to
  // pick above-vs-below placement when there's no room below the anchor.
  const TOOLTIP_HEIGHT_ESTIMATE = 240;

  const updatePosition = () => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipAbove = spaceBelow < TOOLTIP_HEIGHT_ESTIMATE && rect.top > spaceBelow;
    const top = flipAbove ? rect.top - TOOLTIP_GAP - TOOLTIP_HEIGHT_ESTIMATE : rect.bottom + TOOLTIP_GAP;
    // Right-align tooltip to the bar's right edge, clamped to viewport.
    const desiredLeft = rect.right - TOOLTIP_WIDTH;
    const left = Math.max(8, Math.min(desiredLeft, window.innerWidth - TOOLTIP_WIDTH - 8));
    setPos({top, left});
  };

  // Reposition on scroll/resize AND on every animation frame while open. The
  // leaderboard re-sorts every 1.4s without firing scroll/resize, so without
  // the rAF loop the tooltip would visually detach from its anchor when rows
  // swap places. rAF is cheap for one element and self-throttles.
  useEffect(() => {
    if (!open) return;
    updatePosition();
    let raf = requestAnimationFrame(function tick() {
      updatePosition();
      raf = requestAnimationFrame(tick);
    });
    const handler = () => updatePosition();
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [open]);

  return (
    <div
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-describedby={tooltipId}
        aria-label={`${token.ticker} HP ${fmtNum(token.score)}, hover or focus for breakdown`}
        style={{
          all: "unset",
          display: "block",
          width: "100%",
          cursor: "help",
          borderRadius: 6,
          outline: "none",
        }}
      >
        <div style={{height: 6, background: "rgba(255,255,255,0.07)", borderRadius: 99, overflow: "hidden"}}>
          <div
            style={{
              height: "100%",
              width: `${Math.min(100, token.score / 100)}%`,
              borderRadius: 99,
              background: barFill,
              boxShadow: `0 0 8px ${glow}88`,
            }}
          />
        </div>
        <div
          style={{
            fontSize: 9,
            fontFamily: F.mono,
            color: C.dim,
            marginTop: 2,
            letterSpacing: "0.06em",
            fontWeight: 700,
            textAlign: "right",
          }}
        >
          {fmtNum(token.score)}
        </div>
      </button>

      {open && pos && typeof document !== "undefined" &&
        createPortal(<Tooltip id={tooltipId} token={token} top={pos.top} left={pos.left} />, document.body)}
    </div>
  );
}

function Tooltip({id, token, top, left}: {id: string; token: Token; top: number; left: number}) {
  // Each component contributes (score × weight) to the total HP. Sum to show
  // the user how the leaderboard number was actually built.
  const rows = COMPONENT_ORDER.map((key) => {
    const c = token.components[key];
    return {key, ...c, contribution: c.score * c.weight};
  });
  const totalContribution = rows.reduce((sum, r) => sum + r.contribution, 0);

  return (
    <div
      id={id}
      role="tooltip"
      style={{...tooltipShellStyle, top, left}}
    >
      <div style={{display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8}}>
        <div
          style={{
            fontSize: 9,
            fontFamily: F.mono,
            color: C.faint,
            letterSpacing: "0.16em",
            fontWeight: 700,
            textTransform: "uppercase",
          }}
        >
          HP breakdown
        </div>
        <div style={{fontSize: 10, fontFamily: F.mono, color: C.dim}}>
          ${token.ticker}
        </div>
      </div>

      <div style={{display: "flex", flexDirection: "column", gap: 6}}>
        {rows.map((r) => (
          <ComponentRow key={r.key} label={r.label} score={r.score} weight={r.weight} />
        ))}
      </div>

      <div
        style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: `1px solid ${C.lineSoft}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          fontSize: 10,
          fontFamily: F.mono,
          color: C.dim,
        }}
      >
        <span>Total HP</span>
        <span style={{color: C.text, fontWeight: 800, fontSize: 12, fontVariantNumeric: "tabular-nums"}}>
          {(totalContribution * 100).toFixed(1)}%
        </span>
      </div>

      <div style={{marginTop: 6, fontSize: 9, color: C.faint, lineHeight: 1.4}}>
        Each row is the component score × its weight. They sum to the total HP.
      </div>
    </div>
  );
}

function ComponentRow({label, score, weight}: {label: string; score: number; weight: number}) {
  const pctOfMax = score * 100;
  return (
    <div style={{display: "grid", gridTemplateColumns: "1fr auto", gap: 4, alignItems: "baseline"}}>
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8}}>
        <span style={{fontSize: 11, color: C.text, fontFamily: F.display, fontWeight: 600}}>{label}</span>
        <span
          style={{
            fontSize: 8,
            fontFamily: F.mono,
            color: C.faint,
            padding: "1px 5px",
            border: `1px solid ${C.lineSoft}`,
            borderRadius: 99,
            letterSpacing: "0.06em",
            fontWeight: 700,
          }}
        >
          {Math.round(weight * 100)}%
        </span>
      </div>
      <div
        style={{
          fontSize: 11,
          fontFamily: F.mono,
          color: C.text,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          gridColumn: "1 / -1",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div style={{flex: 1, height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 99, overflow: "hidden"}}>
          <div
            style={{
              height: "100%",
              width: `${Math.min(100, pctOfMax)}%`,
              background: `linear-gradient(90deg, ${C.cyan}, ${C.purple})`,
              borderRadius: 99,
            }}
          />
        </div>
        <span style={{minWidth: 36, textAlign: "right", color: C.dim}}>{pctOfMax.toFixed(0)}</span>
      </div>
    </div>
  );
}

const tooltipShellStyle: CSSProperties = {
  position: "fixed",
  zIndex: 1000,
  width: TOOLTIP_WIDTH,
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(15, 6, 28, 0.96)",
  border: `1px solid ${C.line}`,
  boxShadow: "0 12px 28px rgba(0, 0, 0, 0.5)",
  backdropFilter: "blur(6px)",
  pointerEvents: "none",
};
