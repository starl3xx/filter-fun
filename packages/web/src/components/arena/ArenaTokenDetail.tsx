"use client";

/// Token detail panel (spec §19.8).
///
/// Right-column card. When a leaderboard row is selected, this panel reads
/// the token from the existing `/tokens` cache (no separate fetch) and
/// renders:
///
///   - HP trend sparkline (largest chart we can render against current data;
///     price-history rendering will land alongside trade indexing — this
///     uses the local trend buffer the leaderboard already maintains)
///   - HP component breakdown using spec §6.6 labels (NEVER the internal names)
///   - Liquidity depth + holder count (placeholder "0" until indexing lands)
///   - "Trade $TICKER" button → opens stock Uniswap interface in a new tab
///
/// The custom V4 swap UI is explicitly deferred (see PR body / spec §19.8).

import {Triangle} from "@/components/Triangle";
import type {SeasonResponse, TokenResponse} from "@/lib/arena/api";
import {tradeTokenUrl} from "@/lib/arena/api";
import {fmtPctChange} from "@/lib/arena/format";
import {HP_COMPONENT_COLORS, HP_KEYS_IN_ORDER, HP_LABELS, type HpKey} from "@/lib/arena/hpLabels";
import {fmtNum, fmtUSD, fmtPrice} from "@/lib/format";
import {sparkPath} from "@/lib/sparkline";
import {C, F, tickerColor} from "@/lib/tokens";

import {ArenaHpBar} from "./HpBar";
import {StatusBadge} from "./StatusBadge";

export type ArenaTokenDetailProps = {
  token: TokenResponse | null;
  /// HP trend buffer for the selected token. Shared with the leaderboard.
  trend: number[];
  season: SeasonResponse | null;
  /// `"base"` or `"base-sepolia"` — picked from the wagmi env at the page level.
  chain: "base" | "base-sepolia";
};

export function ArenaTokenDetail({token, trend, season, chain}: ArenaTokenDetailProps) {
  return (
    <aside
      aria-label="Token detail"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        padding: 16,
        borderRadius: 14,
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${C.line}`,
        minHeight: 480,
      }}
    >
      {token ? (
        <Detail token={token} trend={trend} season={season} chain={chain} />
      ) : (
        <Empty />
      )}
    </aside>
  );
}

function Empty() {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 8, alignItems: "center", justifyContent: "center", flex: 1, color: C.faint, textAlign: "center"}}>
      <Triangle size={22} />
      <span style={{fontSize: 12, fontFamily: F.mono, letterSpacing: "0.08em"}}>Select a token from the leaderboard</span>
    </div>
  );
}

function Detail({token, trend, season, chain}: {token: TokenResponse; trend: number[]; season: SeasonResponse | null; chain: "base" | "base-sepolia"}) {
  const priceNum = Number(token.price);
  const hasPrice = Number.isFinite(priceNum) && priceNum > 0;
  const liquidityNum = Number(token.liquidity);
  const hasLiquidity = Number.isFinite(liquidityNum) && liquidityNum > 0;

  return (
    <>
      <Heading token={token} />

      <PriceLine hasPrice={hasPrice} priceNum={priceNum} change={token.priceChange24h} />

      <ChartCard trend={trend} />

      <HpBreakdown components={token.components} hp={token.hp} />

      <Stats hasLiquidity={hasLiquidity} liquidity={liquidityNum} holders={token.holders} volume24h={token.volume24h} season={season} />

      {(() => {
        const {url, label} = tradeTokenUrl(token.token, chain);
        return (
          <>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                marginTop: "auto",
                display: "block",
                textAlign: "center",
                padding: "10px 14px",
                borderRadius: 10,
                background: `linear-gradient(135deg, ${C.pink}, ${C.purple})`,
                color: "#fff",
                fontFamily: F.display,
                fontWeight: 800,
                fontSize: 14,
                letterSpacing: "0.04em",
                textDecoration: "none",
                boxShadow: `0 4px 18px ${C.pink}44`,
              }}
            >
              {label} ↗
            </a>
            <span style={{fontSize: 9, fontFamily: F.mono, color: C.faint, textAlign: "center", letterSpacing: "0.08em"}}>
              {chain === "base"
                ? "Opens Uniswap interface · FilterHook V4 routing lands in a follow-up"
                : "Sepolia testnet · Uniswap interface doesn't support testnets — Basescan token page until the FilterHook routing UI lands"}
            </span>
          </>
        );
      })()}
    </>
  );
}

function Heading({token}: {token: TokenResponse}) {
  const noDollar = token.ticker.startsWith("$") ? token.ticker.slice(1) : token.ticker;
  return (
    <div style={{display: "flex", alignItems: "center", gap: 12}}>
      <div
        style={{
          width: 38,
          height: 38,
          borderRadius: 10,
          background: tickerColor(noDollar),
          display: "grid",
          placeItems: "center",
          fontSize: 12,
          fontWeight: 800,
          color: "#1a012a",
          fontFamily: F.display,
        }}
      >
        {noDollar.slice(0, 2)}
      </div>
      <div style={{flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2}}>
        <div style={{display: "flex", alignItems: "center", gap: 6}}>
          <span style={{fontSize: 18, fontFamily: F.display, fontWeight: 800, letterSpacing: "-0.01em"}}>{token.ticker}</span>
          <BagLockBadge bagLock={token.bagLock} />
        </div>
        <div style={{fontSize: 11, fontFamily: F.mono, color: C.faint, letterSpacing: "0.04em"}}>
          {token.token.slice(0, 6)}…{token.token.slice(-4)}
        </div>
      </div>
      <StatusBadge status={token.status} />
    </div>
  );
}

/// Bag-lock badge (Epic 1.13). Renders only for currently-locked tokens — an
/// "unlocked" state is the default and a missing badge is the right signal.
/// Pink-red gradient matches the ▼ brand glyph; copy is "Locked" + a short
/// countdown when < 30 days. The tooltip is the deeper-context surface.
function BagLockBadge({bagLock}: {bagLock: TokenResponse["bagLock"]}) {
  if (!bagLock?.isLocked || !bagLock.unlockTimestamp) return null;
  const unlockMs = bagLock.unlockTimestamp * 1000;
  const remainingMs = unlockMs - Date.now();
  const days = Math.max(0, Math.floor(remainingMs / 86_400_000));
  const dateLabel = new Date(unlockMs).toLocaleDateString();
  const showCountdown = days < 30;
  const tooltip =
    `Creator has locked their personal holdings until ${new Date(unlockMs).toLocaleString()}. ` +
    `What this means →`;
  return (
    <a
      href="https://docs.filter.fun/creators/bag-lock"
      target="_blank"
      rel="noopener noreferrer"
      data-testid="arena-baglock-badge"
      data-baglock-locked="true"
      title={tooltip}
      aria-label={`Bag locked until ${dateLabel}. Open bag-lock docs.`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 7px",
        borderRadius: 6,
        background: `linear-gradient(135deg, ${C.pink}, ${C.red})`,
        color: "#fff",
        fontFamily: F.mono,
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        textDecoration: "none",
        boxShadow: `0 2px 10px ${C.pink}44`,
      }}
    >
      <span aria-hidden style={{fontSize: 9}}>▼</span>
      <span>Locked{showCountdown ? ` · ${days}d` : ""}</span>
    </a>
  );
}

function PriceLine({hasPrice, priceNum, change}: {hasPrice: boolean; priceNum: number; change: number}) {
  return (
    <div style={{display: "flex", alignItems: "baseline", gap: 12}}>
      <span style={{fontSize: 28, fontFamily: F.mono, fontWeight: 800, color: hasPrice ? C.text : C.faint, fontVariantNumeric: "tabular-nums"}}>
        {hasPrice ? fmtPrice(priceNum) : "—"}
      </span>
      <span style={{fontSize: 14, fontFamily: F.mono, fontWeight: 800, color: change > 0 ? C.green : change < 0 ? C.red : C.faint}}>
        {change !== 0 ? fmtPctChange(change) : "0.0%"}
      </span>
      <span style={{fontSize: 9, color: C.faint, fontFamily: F.mono, letterSpacing: "0.08em"}}>24H</span>
    </div>
  );
}

function ChartCard({trend}: {trend: number[]}) {
  const w = 280;
  const h = 96;
  const hasData = trend.length >= 2;
  return (
    <div
      aria-label="HP trend"
      style={{
        background: "rgba(255,255,255,0.02)",
        border: `1px solid ${C.lineSoft}`,
        borderRadius: 10,
        padding: 12,
      }}
    >
      <div style={{display: "flex", justifyContent: "space-between", marginBottom: 8}}>
        <span style={{fontSize: 9, fontFamily: F.mono, color: C.faint, letterSpacing: "0.16em", fontWeight: 700, textTransform: "uppercase"}}>
          HP trend
        </span>
        <span style={{fontSize: 9, fontFamily: F.mono, color: C.faint, letterSpacing: "0.04em"}}>
          {hasData ? `${trend.length} samples` : "collecting…"}
        </span>
      </div>
      <svg width={"100%"} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{display: "block"}}>
        {hasData ? (
          <path
            d={sparkPath(trend, w, h, 4)}
            fill="none"
            stroke={C.cyan}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <line x1={4} y1={h / 2} x2={w - 4} y2={h / 2} stroke={C.faint} strokeWidth={1} strokeDasharray="3 4" />
        )}
      </svg>
    </div>
  );
}

function HpBreakdown({components, hp}: {components: TokenResponse["components"]; hp: number}) {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 8}}>
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
        <span style={{fontSize: 11, fontFamily: F.mono, color: C.dim, letterSpacing: "0.16em", fontWeight: 800, textTransform: "uppercase"}}>
          HP breakdown
        </span>
        <span style={{fontSize: 12, fontFamily: F.mono, fontWeight: 800, color: C.text, fontVariantNumeric: "tabular-nums"}}>
          {hp}/100
        </span>
      </div>
      <ArenaHpBar hp={hp} showValue={false} />
      <div style={{display: "flex", flexDirection: "column", gap: 6, marginTop: 4}}>
        {HP_KEYS_IN_ORDER.map((key) => (
          <ComponentRow
            key={key}
            label={HP_LABELS[key]}
            score={components[key as HpKey] ?? 0}
            color={HP_COMPONENT_COLORS[key]}
          />
        ))}
      </div>
    </div>
  );
}

function ComponentRow({label, score, color}: {label: string; score: number; color: string}) {
  const pct = Math.max(0, Math.min(100, Math.round(score * 100)));
  return (
    <div style={{display: "grid", gridTemplateColumns: "1fr 60px 32px", alignItems: "center", gap: 8, fontSize: 11}}>
      <span style={{color, fontFamily: F.display, fontWeight: 600}}>{label}</span>
      <div style={{height: 4, borderRadius: 99, background: "rgba(255,255,255,0.06)", overflow: "hidden"}}>
        <div style={{height: "100%", width: `${pct}%`, background: `linear-gradient(90deg, ${color}, ${color}cc)`}} />
      </div>
      <span style={{fontFamily: F.mono, fontVariantNumeric: "tabular-nums", color: C.text, fontSize: 11, textAlign: "right"}}>
        {pct}
      </span>
    </div>
  );
}

function Stats({
  hasLiquidity,
  liquidity,
  holders,
  volume24h,
  season,
}: {
  hasLiquidity: boolean;
  liquidity: number;
  holders: number;
  volume24h: string;
  season: SeasonResponse | null;
}) {
  const volNum = Number(volume24h);
  const hasVol = Number.isFinite(volNum) && volNum > 0;
  return (
    <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8}}>
      <Stat label="Liquidity" value={hasLiquidity ? fmtUSD(liquidity) : "—"} />
      <Stat label="Holders" value={holders > 0 ? fmtNum(holders) : "—"} />
      <Stat label="24h volume" value={hasVol ? fmtUSD(volNum) : "—"} />
      <Stat label="Phase" value={season ? season.phase : "—"} />
    </div>
  );
}

function Stat({label, value}: {label: string; value: string}) {
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.02)",
        border: `1px solid ${C.lineSoft}`,
        borderRadius: 8,
        padding: 8,
      }}
    >
      <div style={{fontSize: 9, fontFamily: F.mono, color: C.faint, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700}}>
        {label}
      </div>
      <div style={{fontFamily: F.mono, fontSize: 13, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums", marginTop: 2}}>
        {value}
      </div>
    </div>
  );
}
