"use client";

import {ArenaHpBar, colorForHp} from "@/components/arena/HpBar";
import type {TokenResponse} from "@/lib/arena/api";
import {HP_MAX} from "@/lib/arena/hp";
import {HP_KEYS_IN_ORDER, HP_LABELS, type HpKey} from "@/lib/arena/hpLabels";
import {C, F} from "@/lib/tokens";

import {Card} from "./Card";

/// Composite HP + 5 component breakdown using spec §6.6 user-facing labels.
/// NEVER expose internal field names like "velocity" — `HP_LABELS` is the
/// single source of truth for the translation. Lifted from the arena's
/// existing breakdown panel; reused here verbatim so the muscle memory
/// transfers between Arena and Admin Console.
///
/// Epic 1.18: HP composite scale is integer `[0, HP_MAX]` (= [0, 10000]).
/// Component scores remain `[0, 1]` floats — the per-component bars below
/// render them as a 0-100 percentage; we map that pct into the int10k
/// space (× 100) when picking a bucket colour so the colour buckets in
/// `colorForHp` (also int10k now) apply consistently.

export function HpPanel({token}: {token: TokenResponse}) {
  return (
    <Card label="Health">
      <div style={{display: "flex", alignItems: "baseline", gap: 14, marginBottom: 14}}>
        <span
          style={{
            fontSize: 34,
            fontWeight: 800,
            fontFamily: F.display,
            letterSpacing: "-0.04em",
            color: colorForHp(token.hp),
          }}
        >
          {token.hp}
        </span>
        <span style={{fontSize: 11, color: C.faint, fontFamily: F.mono, letterSpacing: "0.1em"}}>
          / {HP_MAX}
        </span>
        <div style={{flex: 1}}>
          <ArenaHpBar hp={token.hp} width={140} showValue={false} />
        </div>
      </div>
      <div style={{display: "grid", gap: 8}}>
        {HP_KEYS_IN_ORDER.map((k: HpKey) => {
          const raw = token.components[k] ?? 0;
          const pct = Math.round(raw * 100);
          // Translate component-pct (0-100) into the int10k bucket space
          // for `colorForHp`, which now buckets against HP_MAX.
          const bucketColor = colorForHp(pct * 100);
          return (
            <div key={k}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 11,
                  color: C.dim,
                  fontFamily: F.mono,
                  marginBottom: 3,
                }}
              >
                <span>{HP_LABELS[k]}</span>
                <span style={{color: C.text, fontWeight: 700}}>{pct}</span>
              </div>
              <div
                style={{
                  height: 4,
                  borderRadius: 99,
                  background: "rgba(255,255,255,0.06)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    background: `linear-gradient(90deg, ${bucketColor}, ${bucketColor}cc)`,
                    transition: "width 0.4s ease",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
