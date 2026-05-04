"use client";

import {useEffect, useState} from "react";

import type {AlertEntry} from "@/lib/operator/api";
import {C, F} from "@/lib/tokens";

/// Top-of-page alert stack (Epic 1.21 / spec §47.5). Renders one row per active
/// alert, dismissable per-user (state persists in `sessionStorage` so a focus-
/// loss + return doesn't re-fire the same alerts; a fresh occurrence with a new
/// `id` re-shows). Errors render in red, warnings in yellow.

const DISMISS_KEY = "filter-fun:operator:dismissed-alerts";

export function AlertsBanner({alerts}: {alerts: AlertEntry[]}) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = sessionStorage.getItem(DISMISS_KEY);
      if (raw) setDismissed(new Set(JSON.parse(raw) as string[]));
    } catch {
      // ignore — corrupt session storage falls through to empty set.
    }
  }, []);

  function dismiss(id: string) {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      if (typeof window !== "undefined") {
        try {
          sessionStorage.setItem(DISMISS_KEY, JSON.stringify(Array.from(next)));
        } catch {
          // ignore
        }
      }
      return next;
    });
  }

  const visible = alerts.filter((a) => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  return (
    <div style={{display: "flex", flexDirection: "column", gap: 8, marginBottom: 12}}>
      {visible.map((a) => {
        const tone = a.level === "error" ? C.red : C.yellow;
        return (
          <div
            key={a.id}
            role="alert"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 12,
              padding: "10px 14px",
              borderRadius: 10,
              border: `1px solid ${tone}66`,
              background: `${tone}1A`,
              color: C.text,
              fontFamily: F.display,
              fontSize: 13,
            }}
          >
            <span
              style={{
                color: tone,
                fontFamily: F.mono,
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                flexShrink: 0,
              }}
            >
              ▼ {a.level === "error" ? "ALERT" : "WARN"}
            </span>
            <div style={{flex: 1, minWidth: 0}}>
              <div style={{fontWeight: 700}}>{a.message}</div>
              <div style={{color: C.dim, fontFamily: F.mono, fontSize: 11, marginTop: 4}}>
                source: {a.source} · since {new Date(a.since * 1000).toISOString()}
              </div>
            </div>
            <button
              type="button"
              onClick={() => dismiss(a.id)}
              style={{
                background: "transparent",
                border: `1px solid ${tone}55`,
                color: tone,
                fontFamily: F.mono,
                fontSize: 11,
                fontWeight: 800,
                padding: "4px 8px",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              dismiss
            </button>
          </div>
        );
      })}
    </div>
  );
}
