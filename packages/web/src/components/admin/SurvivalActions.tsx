"use client";

import type {TokenResponse} from "@/lib/arena/api";
import {C, F} from "@/lib/tokens";

import {Card} from "./Card";

/// Heuristic recommendation widget. Strictly informational — the protocol
/// doesn't reward "doing the recommended thing" and the copy must NOT imply
/// it does. Each tip points at a single component that's underperforming
/// relative to a static threshold; if everything's healthy, the widget shows
/// "All systems steady" rather than fishing for something to flag.

export type SurvivalActionsProps = {
  token: TokenResponse;
};

type Tip = {label: string; copy: string};

const THRESHOLD = 0.45;

export function SurvivalActions({token}: SurvivalActionsProps) {
  const tips = computeTips(token);
  return (
    <Card label="Survival signals">
      {tips.length === 0 ? (
        <p style={{margin: 0, fontSize: 13, color: C.dim, fontFamily: F.display}}>
          All systems steady — no underperforming components right now.
        </p>
      ) : (
        <ul style={{margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10}}>
          {tips.map((t) => (
            <li key={t.label} style={{display: "flex", gap: 10, alignItems: "flex-start"}}>
              <span aria-hidden style={{color: C.yellow, fontWeight: 800}}>▼</span>
              <div>
                <div style={{fontSize: 12, color: C.text, fontWeight: 700, fontFamily: F.display}}>{t.label}</div>
                <div style={{fontSize: 11, color: C.dim, fontFamily: F.display, lineHeight: 1.5}}>{t.copy}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p style={{marginTop: 10, fontSize: 10, color: C.faint, fontFamily: F.mono, letterSpacing: "0.06em"}}>
        SIGNALS ONLY · NOT REWARDED · NOT PRESCRIPTIVE
      </p>
    </Card>
  );
}

/// Pure tip computation — exported so unit tests can exercise the threshold
/// boundaries without rendering React.
export function computeTips(token: TokenResponse): Tip[] {
  const tips: Tip[] = [];
  if (token.components.retention < THRESHOLD) {
    tips.push({
      label: "Holder conviction is dropping",
      copy: "Holders are exiting faster than the cohort average. Community engagement may help.",
    });
  }
  if (token.components.stickyLiquidity < THRESHOLD) {
    tips.push({
      label: "Liquidity strength is thin",
      copy: "Sticky liquidity is below the cohort comfort zone. Adding LP would strengthen the floor.",
    });
  }
  if (token.components.effectiveBuyers < THRESHOLD) {
    tips.push({
      label: "Real participation is low",
      copy: "Few unique buyers compared to volume. Wash-trading discount is biting your HP.",
    });
  }
  if (token.components.velocity < THRESHOLD) {
    tips.push({
      label: "Buying activity is slowing",
      copy: "Trade volume slipping vs the cohort. Renewed attention typically lifts this within hours.",
    });
  }
  return tips;
}
