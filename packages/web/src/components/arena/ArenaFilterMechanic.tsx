/// Always-visible filter mechanic info card (spec §19.9).
///
///   🔻 The filter — Top 6 survive. Bottom 6 get cut. Their liquidity funds the winner.

import {C, F} from "@/lib/tokens";

export function ArenaFilterMechanic() {
  return (
    <section
      aria-label="Filter mechanic"
      style={{
        position: "relative",
        borderRadius: 14,
        padding: 14,
        background: "linear-gradient(135deg, rgba(255,45,85,0.12), rgba(156,92,255,0.08))",
        border: `1px solid ${C.red}55`,
        overflow: "hidden",
      }}
    >
      <div style={{display: "flex", alignItems: "center", gap: 8, marginBottom: 6}}>
        <span aria-hidden style={{fontSize: 16}}>🔻</span>
        <span style={{fontFamily: F.display, fontWeight: 800, fontSize: 13, letterSpacing: "0.04em", color: C.red}}>
          The filter
        </span>
      </div>
      <p style={{margin: 0, fontSize: 12, lineHeight: 1.5, color: C.dim}}>
        Top 6 survive. Bottom 6 get cut.{" "}
        <span style={{color: C.text, fontWeight: 700}}>Their liquidity funds the winner.</span>
      </p>
    </section>
  );
}
