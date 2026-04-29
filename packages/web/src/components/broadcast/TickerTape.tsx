"use client";

import {fmtPrice} from "@/lib/format";
import {type Token} from "@/lib/seed";
import {C, F, tickerColor} from "@/lib/tokens";

type Props = {tokens: Token[]};

export function TickerTape({tokens}: Props) {
  const seq = [...tokens, ...tokens];
  return (
    <div
      style={{
        height: 36,
        borderBottom: `1px solid ${C.line}`,
        borderTop: `1px solid ${C.line}`,
        background: `linear-gradient(90deg, ${C.purple}1a, ${C.pink}1a, ${C.cyan}1a)`,
        overflow: "hidden",
        position: "relative",
        display: "flex",
        alignItems: "center",
      }}
      aria-label="Live token ticker"
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 100,
          zIndex: 2,
          background: `linear-gradient(90deg, ${C.bg}, transparent)`,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: 100,
          zIndex: 2,
          background: `linear-gradient(270deg, ${C.bg}, transparent)`,
          pointerEvents: "none",
        }}
      />
      <div
        className="ff-marquee"
        style={{
          display: "flex",
          gap: 28,
          whiteSpace: "nowrap",
          fontFamily: F.mono,
          fontSize: 12,
        }}
      >
        {seq.map((t, i) => (
          <div key={`${t.ticker}-${i}`} style={{display: "flex", alignItems: "center", gap: 8, color: C.dim}}>
            <span
              style={{
                width: 4,
                height: 14,
                borderRadius: 2,
                background: tickerColor(t.ticker),
                boxShadow: `0 0 6px ${tickerColor(t.ticker)}aa`,
              }}
            />
            <span style={{color: C.text, fontWeight: 800}}>${t.ticker}</span>
            <span>{fmtPrice(t.price)}</span>
            <span style={{color: t.ch >= 0 ? C.green : C.red, fontWeight: 700}}>
              {t.ch >= 0 ? "▲" : "▼"} {Math.abs(t.ch).toFixed(2)}%
            </span>
            {t.status === "risk" && <span style={{color: C.red}}>🔻</span>}
            {t.status === "finalist" && <span style={{color: C.yellow}}>👑</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
