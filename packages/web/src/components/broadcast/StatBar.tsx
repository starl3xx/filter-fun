import {C, F} from "@/lib/tokens";

type Props = {
  label: string;
  cur: number;
  max: number;
  color: string;
  suffix: string;
};

export function StatBar({label, cur, max, color, suffix}: Props) {
  const pct = Math.min(100, (cur / max) * 100);
  return (
    <div style={{marginTop: 6}}>
      <div style={{display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 3, fontFamily: F.mono, letterSpacing: "0.08em"}}>
        <span style={{color: C.dim, fontWeight: 700}}>{label}</span>
        <span style={{color: C.text, fontWeight: 700}}>{suffix}</span>
      </div>
      <div style={{height: 7, background: "rgba(255,255,255,0.07)", borderRadius: 99, overflow: "hidden", position: "relative"}}>
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            borderRadius: 99,
            background: `linear-gradient(90deg, ${color}, ${color}aa)`,
            boxShadow: `0 0 10px ${color}88`,
          }}
        />
      </div>
    </div>
  );
}
