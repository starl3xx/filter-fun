"use client";

/// Phase 1 audit C-5 (2026-05-01) shared error banner. The same component
/// previously lived inline in both `app/page.tsx` and `app/launch/page.tsx`;
/// bugbot finding on PR #57 flagged the duplication as drift-prone (any
/// future fix or style change had to be applied to both copies). Extracted
/// here so the two pages reference one source of truth.
///
/// Sits between the ticker/top bar and the main grid on each page. Auto-
/// clears as soon as the next polling-hook fetch succeeds (the `error` prop
/// returns to `null`); we deliberately do NOT offer a manual dismiss
/// control because the next poll IS the retry, and a dismiss would mask a
/// recurring failure.

import {C, F} from "@/lib/tokens";

export function DataErrorBanner({error}: {error: Error}) {
  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        position: "relative",
        zIndex: 1,
        margin: "8px 16px 0",
        padding: "8px 14px",
        borderRadius: 10,
        border: `1px solid ${C.red}55`,
        background: `${C.red}14`,
        color: C.text,
        fontFamily: F.mono,
        fontSize: 11,
        letterSpacing: "0.05em",
        display: "flex",
        gap: 10,
        alignItems: "center",
      }}
    >
      <span style={{color: C.red, fontWeight: 800, letterSpacing: "0.16em", textTransform: "uppercase"}}>
        ▼ Live data error
      </span>
      <span style={{color: C.dim}}>
        Indexer call failed — showing cached state. Will retry on the next poll. ({error.message})
      </span>
    </div>
  );
}
