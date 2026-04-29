import {MISSIONS, type Mission, type Token} from "@/lib/seed";
import {C, F, tickerColor} from "@/lib/tokens";

type Props = {tokens: Token[]};

export function Missions({tokens}: Props) {
  return (
    <section
      aria-label="Finalist quests"
      style={{
        padding: 14,
        borderRadius: 14,
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${C.line}`,
        backdropFilter: "blur(8px)",
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10}}>
        <div style={{display: "flex", alignItems: "center", gap: 8}}>
          <span aria-hidden style={{fontSize: 16}}>
            🎯
          </span>
          <span style={{fontWeight: 800, fontSize: 13, letterSpacing: "-0.01em", fontFamily: F.display}}>
            Finalist quests
          </span>
        </div>
        <span style={{fontSize: 9, color: C.faint, fontFamily: F.mono, letterSpacing: "0.1em", fontWeight: 700}}>
          {tokens.slice(0, 2).length} ACTIVE
        </span>
      </div>
      <div style={{display: "flex", flexDirection: "column", gap: 8, overflow: "hidden"}}>
        {tokens.slice(0, 2).map((t) => {
          const ms = (MISSIONS[t.ticker] ?? MISSIONS.FILTER ?? []).slice(0, 2);
          return (
            <div
              key={t.ticker}
              style={{
                padding: 10,
                background: "rgba(255,255,255,0.04)",
                border: `1px solid ${C.line}`,
                borderRadius: 10,
              }}
            >
              <div style={{display: "flex", alignItems: "baseline", gap: 6, marginBottom: 6}}>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 800,
                    padding: "2px 7px",
                    borderRadius: 5,
                    background: tickerColor(t.ticker),
                    color: "#1a012a",
                    fontFamily: F.display,
                  }}
                >
                  ${t.ticker}
                </span>
                <span style={{fontSize: 11, color: C.dim}}>{t.name}</span>
              </div>
              {ms.map((m, i) => (
                <MissionBar key={i} m={m} />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MissionBar({m}: {m: Mission}) {
  const pct = Math.min(100, Math.round((m.cur / m.goal) * 100));
  const done = pct >= 100;
  return (
    <div style={{marginTop: 6}}>
      <div style={{display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3}}>
        <span style={{color: C.dim}}>{m.label}</span>
        <span
          style={{
            fontFamily: F.mono,
            color: done ? C.green : C.text,
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {pct}%
        </span>
      </div>
      <div style={{height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 99, overflow: "hidden"}}>
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            borderRadius: 99,
            background: done
              ? `linear-gradient(90deg, ${C.green}, ${C.cyan})`
              : `linear-gradient(90deg, ${C.pink}, ${C.purple})`,
            boxShadow: `0 0 10px ${done ? C.green : C.pink}88`,
          }}
        />
      </div>
    </div>
  );
}
