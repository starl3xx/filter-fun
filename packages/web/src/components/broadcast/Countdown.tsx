import {fmtCountdown} from "@/lib/format";
import {C, F} from "@/lib/tokens";

type Props = {filterIn: number; finalsIn: number};

export function CountdownRow({filterIn, finalsIn}: Props) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1.4fr 1fr",
        gap: 12,
      }}
    >
      <BigCountdown filterIn={filterIn} />
      <CountdownCard
        label="🏆 Finals end"
        value={fmtCountdown(finalsIn, {showDays: true})}
        sub="One winner gets funded"
        gradient={`linear-gradient(135deg, ${C.yellow}33, ${C.pink}1f)`}
        accent={C.yellow}
      />
    </div>
  );
}

function BigCountdown({filterIn}: {filterIn: number}) {
  return (
    <div
      style={{
        padding: "14px 18px",
        borderRadius: 14,
        position: "relative",
        overflow: "hidden",
        background: `linear-gradient(135deg, ${C.red}28, ${C.pink}14)`,
        border: `1px solid ${C.red}55`,
        boxShadow: `0 6px 28px ${C.red}33, inset 0 1px 0 #ffffff10`,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(circle at 0% 100%, ${C.red}33, transparent 60%)`,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
          color: C.red,
          fontWeight: 800,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          fontFamily: F.mono,
        }}
      >
        <span
          className="ff-pulse"
          style={{width: 8, height: 8, borderRadius: 99, background: C.red, boxShadow: `0 0 10px ${C.red}`}}
        />
        🔻 NEXT FILTER · BOTTOM 6 GET CUT
      </div>
      <div style={{position: "relative", display: "flex", alignItems: "baseline", gap: 14, marginTop: 2}}>
        <div
          aria-live="off"
          style={{
            fontSize: 42,
            fontWeight: 900,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "-0.03em",
            color: C.text,
            textShadow: `0 0 28px ${C.red}aa`,
            fontFamily: F.display,
            lineHeight: 1.05,
          }}
        >
          {fmtCountdown(filterIn)}
        </div>
        <div style={{fontSize: 12, color: C.dim}}>final hours</div>
      </div>
    </div>
  );
}

function CountdownCard({
  label,
  value,
  sub,
  gradient,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  gradient: string;
  accent: string;
}) {
  return (
    <div
      style={{
        padding: "14px 18px",
        borderRadius: 14,
        position: "relative",
        overflow: "hidden",
        background: gradient,
        border: `1px solid ${accent}44`,
        boxShadow: `0 4px 18px ${accent}22, inset 0 1px 0 #ffffff10`,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontFamily: F.mono,
          color: accent,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          fontWeight: 800,
        }}
      >
        {label}
      </div>
      <div
        aria-live="off"
        style={{
          fontSize: 28,
          fontWeight: 900,
          fontFamily: F.display,
          letterSpacing: "-0.02em",
          marginTop: 2,
          color: C.text,
          textShadow: `0 0 22px ${accent}66`,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div style={{fontSize: 11, color: C.dim, marginTop: 2}}>{sub}</div>
    </div>
  );
}
