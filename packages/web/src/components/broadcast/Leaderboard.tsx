import {fmtCountdown, fmtNum, fmtUSD} from "@/lib/format";
import {type Token} from "@/lib/seed";
import {C, F, tickerColor} from "@/lib/tokens";

import {HpBar} from "./HpBar";
import {Sparkline} from "./Sparkline";

type Props = {survive: Token[]; filtered: Token[]; filterIn: number};

const COL_TEMPLATE = "40px 32px 1fr 90px 70px 110px 90px";

export function Leaderboard({survive, filtered, filterIn}: Props) {
  return (
    <section
      aria-label="Live leaderboard"
      style={{
        flex: 1,
        minHeight: 0,
        borderRadius: 14,
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${C.line}`,
        backdropFilter: "blur(8px)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "12px 18px",
          borderBottom: `1px solid ${C.line}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "rgba(255,255,255,0.03)",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div style={{display: "flex", alignItems: "center", gap: 10}}>
          <span aria-hidden style={{fontSize: 18}}>
            🏟️
          </span>
          <h2 style={{margin: 0, fontWeight: 800, fontSize: 15, letterSpacing: "-0.01em", fontFamily: F.display}}>
            Live leaderboard
          </h2>
          <span
            style={{
              fontSize: 9,
              fontFamily: F.mono,
              color: C.green,
              padding: "2px 7px",
              background: `${C.green}1a`,
              border: `1px solid ${C.green}55`,
              borderRadius: 99,
              letterSpacing: "0.1em",
              fontWeight: 800,
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <span
              className="ff-pulse"
              style={{width: 6, height: 6, borderRadius: 99, background: C.green, boxShadow: `0 0 8px ${C.green}`}}
            />
            LIVE
          </span>
        </div>
        <div
          style={{
            display: "flex",
            gap: 14,
            fontSize: 10,
            fontFamily: F.mono,
            color: C.dim,
            letterSpacing: "0.1em",
            fontWeight: 700,
          }}
        >
          <span>
            <span style={{color: C.green}}>{survive.length}</span> SURVIVE
          </span>
          <span>
            <span style={{color: C.red}}>{filtered.length}</span> AT RISK 🔻
          </span>
        </div>
      </div>

      {/* Both column header and rows live inside the same scroll container,
          inside a min-width wrapper, so they stay column-aligned even when the
          center grid column is narrower than the leaderboard's natural width
          (1100–1240px viewports). The column header is sticky-pinned to the
          top so it stays visible while the rows scroll vertically. */}
      <div className="ff-scroll" style={{flex: 1, overflow: "auto"}}>
        <div style={{minWidth: 640}}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: COL_TEMPLATE,
              gap: 10,
              padding: "7px 18px",
              fontSize: 9,
              fontFamily: F.mono,
              color: C.faint,
              letterSpacing: "0.1em",
              fontWeight: 700,
              textTransform: "uppercase",
              borderBottom: `1px solid ${C.lineSoft}`,
              position: "sticky",
              top: 0,
              zIndex: 1,
              background: C.panel,
            }}
          >
            <div>#</div>
            <div></div>
            <div>Token</div>
            <div style={{textAlign: "right"}}>Mcap</div>
            <div style={{textAlign: "right"}}>24h</div>
            <div>HP / Score</div>
            <div style={{textAlign: "right"}}>Trend</div>
          </div>
          {survive.map((t, i) => (
            <Row key={t.ticker} token={t} rank={i + 1} />
          ))}
          <FilterLine filterIn={filterIn} />
          {filtered.map((t, i) => (
            <Row key={t.ticker} token={t} rank={survive.length + i + 1} below />
          ))}
        </div>
      </div>
    </section>
  );
}

function Row({token, rank, below}: {token: Token; rank: number; below?: boolean}) {
  const finalist = token.status === "finalist";
  const isFilter = token.ticker === "FILTER";
  return (
    <div
      className={below ? "ff-shake" : undefined}
      style={{
        display: "grid",
        gridTemplateColumns: COL_TEMPLATE,
        gap: 10,
        padding: "8px 18px",
        alignItems: "center",
        borderBottom: `1px solid ${C.lineSoft}`,
        opacity: below ? 0.65 : 1,
        background: finalist ? `linear-gradient(90deg, ${C.yellow}14, transparent 60%)` : "transparent",
      }}
    >
      <div
        style={{
          fontFamily: rank <= 3 ? F.display : F.mono,
          fontSize: rank <= 3 ? 16 : 13,
          fontWeight: 800,
          color: rank === 1 ? C.yellow : below ? C.faint : C.dim,
        }}
      >
        {rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "#" + rank}
      </div>

      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: 7,
          background: tickerColor(token.ticker),
          display: "grid",
          placeItems: "center",
          fontSize: 9,
          fontWeight: 900,
          color: "#1a012a",
          fontFamily: F.display,
          position: "relative",
          boxShadow: finalist ? `0 0 14px ${tickerColor(token.ticker)}aa` : "none",
        }}
      >
        {token.ticker.slice(0, 2)}
        {isFilter && (
          <div
            aria-label="Protocol token"
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              width: 12,
              height: 12,
              background: C.cyan,
              borderRadius: 99,
              fontSize: 8,
              display: "grid",
              placeItems: "center",
              color: "#1a012a",
              fontWeight: 900,
              boxShadow: `0 0 8px ${C.cyan}`,
            }}
          >
            P
          </div>
        )}
      </div>

      <div style={{minWidth: 0}}>
        <div style={{display: "flex", alignItems: "center", gap: 6}}>
          <span style={{fontSize: 14, fontWeight: 800, letterSpacing: "-0.01em", fontFamily: F.display}}>
            ${token.ticker}
          </span>
          {finalist && (
            <span
              style={{
                fontSize: 9,
                padding: "1px 6px",
                borderRadius: 99,
                background: `${C.yellow}33`,
                color: C.yellow,
                fontWeight: 800,
                letterSpacing: "0.06em",
                fontFamily: F.mono,
              }}
            >
              FINALIST
            </span>
          )}
          {token.status === "risk" && <span style={{fontSize: 11, color: C.red}}>🔻</span>}
        </div>
        <div style={{fontSize: 10, color: C.faint}}>{token.name}</div>
      </div>

      <div
        style={{
          textAlign: "right",
          fontFamily: F.mono,
          fontSize: 13,
          fontVariantNumeric: "tabular-nums",
          fontWeight: 600,
        }}
        title={`Price ${token.price.toPrecision(4)} · supply ${fmtNum(token.supply)}`}
      >
        {fmtUSD(token.mcap)}
      </div>
      <div
        style={{
          textAlign: "right",
          fontFamily: F.mono,
          fontSize: 13,
          fontWeight: 800,
          color: token.ch >= 0 ? C.green : C.red,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {token.ch >= 0 ? "+" : ""}
        {token.ch.toFixed(1)}%
      </div>

      <HpBar token={token} below={below} finalist={finalist} />

      <div style={{display: "flex", justifyContent: "flex-end"}}>
        <Sparkline values={token.spark} w={84} h={22} color={token.ch >= 0 ? C.green : C.red} strokeWidth={1.6} />
      </div>
    </div>
  );
}

function FilterLine({filterIn}: {filterIn: number}) {
  return (
    <div
      style={{
        position: "relative",
        height: 46,
        background: `repeating-linear-gradient(45deg, ${C.red}28 0 8px, ${C.red}10 8px 16px)`,
        borderTop: `1.5px solid ${C.red}`,
        borderBottom: `1.5px solid ${C.red}`,
        display: "flex",
        alignItems: "center",
        padding: "0 18px",
        overflow: "hidden",
        boxShadow: `0 0 22px ${C.red}55, inset 0 0 18px ${C.red}28`,
      }}
    >
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "#1a012aee",
          padding: "5px 14px",
          borderRadius: 99,
          border: `1.5px solid ${C.red}`,
          boxShadow: `0 0 16px ${C.red}cc`,
        }}
      >
        <span style={{fontSize: 14}}>🔻</span>
        <span
          style={{
            fontSize: 11,
            fontFamily: F.display,
            fontWeight: 900,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: C.red,
          }}
        >
          FILTER LINE
        </span>
        <span style={{fontSize: 10, fontFamily: F.mono, color: C.dim}}>everything below gets cut</span>
      </div>
      <div style={{flex: 1}} />
      <div
        style={{
          position: "relative",
          fontSize: 11,
          fontFamily: F.mono,
          color: C.red,
          fontWeight: 800,
          letterSpacing: "0.08em",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {fmtCountdown(filterIn)} UNTIL CUT
      </div>
    </div>
  );
}
