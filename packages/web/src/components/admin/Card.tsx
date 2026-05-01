"use client";

import type {ReactNode} from "react";

import {C, F} from "@/lib/tokens";

/// Shared card chrome for the admin console. Mirrors the inline-style pattern
/// used by the arena components — a single dark surface with a soft border, a
/// label header, and content below. Keeps the three columns visually
/// consistent without introducing a new design primitive.

export function Card({label, children}: {label: string; children: ReactNode}) {
  return (
    <section
      style={{
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        padding: "14px 16px",
        marginBottom: 12,
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: C.faint,
          marginBottom: 10,
          fontFamily: F.mono,
          fontWeight: 700,
        }}
      >
        {label}
      </div>
      {children}
    </section>
  );
}

export function Field({k, v}: {k: string; v: ReactNode}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        padding: "6px 0",
        fontSize: 13,
        fontFamily: F.display,
      }}
    >
      <span style={{color: C.dim}}>{k}</span>
      <span style={{color: C.text, fontFamily: F.mono, fontWeight: 600, textAlign: "right"}}>{v}</span>
    </div>
  );
}
