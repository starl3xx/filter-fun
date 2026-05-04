"use client";

import {useEffect, useMemo, useState} from "react";

import {ArenaHpBar, colorForHp} from "@/components/arena/HpBar";
import {useComponentDeltas} from "@/hooks/token/useComponentDeltas";
import type {ComponentDeltasResponse, ComponentKey, SwapImpactRow, TokenResponse} from "@/lib/arena/api";
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
///
/// Epic 1.23 — admin console v2 closeout. Each component mini-bar is now
/// expandable; opening it reveals the last 5 swaps that materially shifted
/// that component's score (per `/tokens/:address/component-deltas`). Open
/// state persists across reloads via `localStorage.adminConsoleDrilldownOpen`
/// (per-component bool map). Polling is lazy — the hook only starts firing
/// once at least one component is open, so closed drilldowns don't burn
/// indexer rate-limit budget.

const DRILLDOWN_STORAGE_KEY = "adminConsoleDrilldownOpen";

type OpenMap = Partial<Record<HpKey, boolean>>;

function readOpenMap(): OpenMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(DRILLDOWN_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as OpenMap;
  } catch {
    // localStorage may be disabled (Safari private mode, etc.) or the value
    // may have been corrupted by hand. Either way, fall through to {}.
  }
  return {};
}

function writeOpenMap(map: OpenMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DRILLDOWN_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Same fall-through reasoning as readOpenMap — quota errors / disabled
    // storage shouldn't break the panel.
  }
}

export function HpPanel({token}: {token: TokenResponse}) {
  const [openMap, setOpenMap] = useState<OpenMap>({});
  // Hydrate from localStorage on mount (NOT during SSR — keeps server output
  // deterministic).
  useEffect(() => {
    setOpenMap(readOpenMap());
  }, []);

  const anyOpen = useMemo(() => Object.values(openMap).some(Boolean), [openMap]);
  const {data: deltas} = useComponentDeltas(token.token, anyOpen);

  function toggleComponent(k: HpKey): void {
    setOpenMap((prev) => {
      const next = {...prev, [k]: !prev[k]};
      writeOpenMap(next);
      return next;
    });
  }

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
          const isOpen = Boolean(openMap[k]);
          return (
            <div key={k}>
              <button
                type="button"
                onClick={() => toggleComponent(k)}
                aria-expanded={isOpen}
                aria-controls={`hp-drilldown-${k}`}
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  textAlign: "left",
                  color: "inherit",
                }}
              >
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
                  <span>
                    <span aria-hidden style={{display: "inline-block", width: 10, color: C.faint}}>
                      {isOpen ? "▾" : "▸"}
                    </span>
                    {HP_LABELS[k]}
                  </span>
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
              </button>
              {isOpen && (
                <DrilldownRows
                  componentKey={k as ComponentKey}
                  data={deltas}
                  chain={resolveChain()}
                  id={`hp-drilldown-${k}`}
                />
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function resolveChain(): "base" | "base-sepolia" {
  return process.env.NEXT_PUBLIC_CHAIN === "base" ? "base" : "base-sepolia";
}

/// Drilldown rendering: per-component swap-impact rows, newest-first. The
/// dispatch's example layout:
///
///   +0.42 velocity · 0.5 ETH buy by 0xabc...123 · 14m ago · [tx]
///
/// Wallet truncation matches the existing leaderboard convention (4-char
/// head + 4-char tail). Tx links open the chain's Basescan tx page;
/// taker links open `/profile/<address>`.
function DrilldownRows({
  componentKey,
  data,
  chain,
  id,
}: {
  componentKey: ComponentKey;
  data: ComponentDeltasResponse | null;
  chain: "base" | "base-sepolia";
  id: string;
}) {
  if (!data) {
    return (
      <div id={id} style={{padding: "8px 12px"}}>
        <span style={{fontSize: 11, color: C.faint, fontFamily: F.mono}}>Loading…</span>
      </div>
    );
  }
  const rows = data.components[componentKey] ?? [];
  if (rows.length === 0) {
    return (
      <div id={id} style={{padding: "8px 12px"}}>
        <span style={{fontSize: 11, color: C.faint, fontFamily: F.mono}}>
          No material shifts (|δ| ≥ {data.threshold.toFixed(2)}).
        </span>
      </div>
    );
  }
  return (
    <div
      id={id}
      role="region"
      aria-label={`${componentKey} drilldown`}
      style={{
        marginTop: 6,
        padding: "6px 0 4px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 11,
        fontFamily: F.mono,
        color: C.dim,
      }}
    >
      {rows.map((row) => (
        <DrilldownRow
          key={`${componentKey}:${row.timestamp}:${row.swap?.txHash ?? "no-swap"}`}
          row={row}
          componentKey={componentKey}
          chain={chain}
        />
      ))}
    </div>
  );
}

function DrilldownRow({
  row,
  componentKey,
  chain,
}: {
  row: SwapImpactRow;
  componentKey: ComponentKey;
  chain: "base" | "base-sepolia";
}) {
  const sign = row.delta >= 0 ? "+" : "−";
  const deltaAbs = Math.abs(row.delta).toFixed(2);
  const deltaColor = row.delta >= 0 ? C.green : C.red;
  // Bugbot PR #101 (Medium): the panel header comment is explicit that
  // internal HP-component field names ("velocity", "effectiveBuyers", ...)
  // MUST NEVER reach the user — `HP_LABELS` is the single source of truth
  // for the spec §6.6 user-facing translation. The drilldown row was
  // rendering the raw key.
  const label = HP_LABELS[componentKey as HpKey] ?? componentKey;
  return (
    <div style={{display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap"}}>
      <span style={{color: deltaColor, fontWeight: 800}}>
        {sign}
        {deltaAbs} {label}
      </span>
      {row.swap ? (
        <>
          <span>·</span>
          <span style={{color: C.text}}>
            {wethValueLabel(row.swap.wethValue)} {row.swap.side === "BUY" ? "buy" : "sell"} by{" "}
            <a href={`/profile/${row.swap.taker}`} style={{color: C.cyan, textDecoration: "none"}}>
              {truncateAddress(row.swap.taker)}
            </a>
          </span>
          <span>·</span>
          <span>{ageLabel(row.timestamp)} ago</span>
          <span>·</span>
          <a
            href={txExplorerUrl(row.swap.txHash, chain)}
            target="_blank"
            rel="noopener noreferrer"
            style={{color: C.cyan, textDecoration: "none"}}
          >
            [tx]
          </a>
        </>
      ) : (
        <>
          <span>·</span>
          <span>{ageLabel(row.timestamp)} ago</span>
        </>
      )}
    </div>
  );
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function wethValueLabel(weiStr: string): string {
  // Decimal-wei → decimal-ether with up to 3 places, dropped trailing zeros.
  // Cheap to compute on the client and avoids dragging in viem's formatUnits
  // for a single label.
  let wei: bigint;
  try {
    wei = BigInt(weiStr);
  } catch {
    return "? ETH";
  }
  if (wei === 0n) return "0 ETH";
  const whole = wei / 10n ** 18n;
  const fracMilli = (wei % 10n ** 18n) / 10n ** 15n; // 3-decimal resolution
  if (whole === 0n && fracMilli === 0n) {
    return "<0.001 ETH";
  }
  const fracStr = fracMilli.toString().padStart(3, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole.toString()}.${fracStr} ETH` : `${whole.toString()} ETH`;
}

function ageLabel(timestampSec: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const ageSec = Math.max(0, nowSec - timestampSec);
  if (ageSec < 60) return `${ageSec}s`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m`;
  if (ageSec < 86_400) return `${Math.floor(ageSec / 3600)}h`;
  return `${Math.floor(ageSec / 86_400)}d`;
}

function txExplorerUrl(txHash: string, chain: "base" | "base-sepolia"): string {
  return chain === "base"
    ? `https://basescan.org/tx/${txHash}`
    : `https://sepolia.basescan.org/tx/${txHash}`;
}
