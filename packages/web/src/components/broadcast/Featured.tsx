import {fmtNum, fmtPrice, fmtUSD} from "@/lib/format";
import {type Token} from "@/lib/seed";
import {C, F} from "@/lib/tokens";

import {Sparkline} from "./Sparkline";
import {StatBar} from "./StatBar";

type Props = {token: Token | undefined};

export function Featured({token}: Props) {
  if (!token) return null;
  return (
    <section
      aria-label="Currently leading token"
      style={{
        padding: 18,
        borderRadius: 16,
        position: "relative",
        overflow: "hidden",
        background: `
          radial-gradient(circle at 50% 0%, ${C.yellow}28, transparent 60%),
          linear-gradient(160deg, ${C.purple}2a, ${C.panel}cc)
        `,
        border: `1.5px solid ${C.yellow}66`,
        boxShadow: `0 10px 32px ${C.purple}55, inset 0 1px 0 #ffffff22`,
      }}
    >
      <div style={{display: "flex", alignItems: "center", gap: 8}}>
        <div aria-hidden style={{fontSize: 22}}>
          👑
        </div>
        <div
          style={{
            fontSize: 10,
            fontFamily: F.mono,
            color: C.yellow,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            fontWeight: 800,
          }}
        >
          Currently getting funded
        </div>
      </div>
      <div style={{display: "flex", alignItems: "baseline", gap: 10, marginTop: 8, flexWrap: "wrap"}}>
        <div
          style={{
            fontSize: 42,
            fontWeight: 900,
            letterSpacing: "-0.03em",
            lineHeight: 1,
            background: `linear-gradient(135deg, ${C.yellow}, ${C.pink})`,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            fontFamily: F.display,
          }}
        >
          ${token.ticker}
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: F.mono,
            color: C.dim,
            padding: "3px 8px",
            border: `1px solid ${C.line}`,
            borderRadius: 99,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
          }}
        >
          #{token.rank} · {token.name}
        </div>
      </div>
      <div style={{display: "flex", alignItems: "baseline", gap: 14, marginTop: 6, flexWrap: "wrap"}}>
        <div
          style={{
            fontSize: 30,
            fontWeight: 800,
            fontFamily: F.mono,
            fontVariantNumeric: "tabular-nums",
          }}
          title={`Price ${fmtPrice(token.price)} · supply ${fmtNum(token.supply)}`}
        >
          {fmtUSD(token.mcap)}
        </div>
        <div
          style={{
            fontSize: 14,
            fontWeight: 800,
            color: token.ch >= 0 ? C.green : C.red,
            padding: "3px 8px",
            borderRadius: 6,
            background: (token.ch >= 0 ? C.green : C.red) + "22",
            fontFamily: F.mono,
          }}
        >
          {token.ch >= 0 ? "▲" : "▼"} {Math.abs(token.ch).toFixed(2)}%
        </div>
        <div style={{fontSize: 11, fontFamily: F.mono, color: C.dim, marginLeft: "auto"}}>
          {fmtPrice(token.price)} · {fmtNum(token.supply)} supply
        </div>
      </div>
      <div style={{marginTop: 10, position: "relative"}}>
        <Sparkline values={token.spark} w={272} h={56} color={C.yellow} strokeWidth={2.5} fill="url(#ff-feat-grad)" />
        <svg width="0" height="0" style={{position: "absolute"}} aria-hidden>
          <defs>
            <linearGradient id="ff-feat-grad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={C.yellow} stopOpacity="0.35" />
              <stop offset="100%" stopColor={C.yellow} stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>
      </div>
      <div style={{marginTop: 10}}>
        <StatBar label="HOLDERS" cur={token.holders} max={10000} color={C.cyan} suffix={fmtNum(token.holders)} />
        <StatBar label="LIQUIDITY" cur={token.liq} max={2000000} color={C.green} suffix={fmtUSD(token.liq)} />
        <StatBar label="SCORE" cur={token.score} max={10000} color={C.yellow} suffix={fmtNum(token.score)} />
      </div>
      <div style={{display: "flex", gap: 8, marginTop: 14}}>
        <button
          type="button"
          style={{
            flex: 1,
            padding: "12px 0",
            borderRadius: 10,
            border: "none",
            cursor: "pointer",
            background: `linear-gradient(135deg, ${C.yellow}, ${C.pink})`,
            color: "#1a012a",
            fontWeight: 900,
            fontSize: 14,
            fontFamily: F.display,
            letterSpacing: "-0.01em",
            boxShadow: `0 6px 18px ${C.pink}66, inset 0 1px 0 #ffffff44`,
          }}
        >
          BUY ${token.ticker} ⚡
        </button>
        <button
          type="button"
          style={{
            padding: "12px 14px",
            borderRadius: 10,
            border: `1px solid ${C.line}`,
            background: "rgba(255,255,255,0.05)",
            color: C.text,
            fontWeight: 700,
            fontSize: 13,
            cursor: "pointer",
            fontFamily: F.display,
          }}
        >
          View
        </button>
        <button
          type="button"
          aria-label="Share"
          style={{
            padding: "12px 12px",
            borderRadius: 10,
            border: `1px solid ${C.line}`,
            background: "rgba(255,255,255,0.05)",
            color: C.dim,
            cursor: "pointer",
          }}
        >
          ↗
        </button>
      </div>
    </section>
  );
}
