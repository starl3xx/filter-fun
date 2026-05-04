"use client";

import type {ReactNode} from "react";

import {C, F} from "@/lib/tokens";

/// Lightweight card primitive for the operator console. Mirrors the shape of the
/// creator-admin Card (component reused conceptually rather than literally; the
/// operator surface uses a slightly tighter padding to fit more cards per
/// viewport, and a label-glyph slot for the "OPERATOR" / "RECOVERY" / etc.
/// section markers per spec §47.7).

export interface OperatorCardProps {
  label: string;
  /// Optional supporting line under the label (e.g. "live data" for SSE-bound
  /// cards or "snapshot" for poll-only data).
  sublabel?: string;
  /// Optional accent colour for the label chip — defaults to the operator
  /// accent (red, mirroring the LIVE chip in the TopBar). Pass a brand-kit
  /// hex (e.g. C.cyan) to differentiate sections (recovery vs. governance vs.
  /// comms, per spec §47.4).
  accent?: string;
  children: ReactNode;
}

export function OperatorCard({label, sublabel, accent = C.red, children}: OperatorCardProps) {
  return (
    <section
      style={{
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 10,
        padding: 16,
        marginBottom: 12,
      }}
    >
      <header style={{marginBottom: 12, display: "flex", alignItems: "baseline", gap: 12}}>
        <span
          style={{
            color: accent,
            fontFamily: F.mono,
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
          }}
        >
          ▼ {label}
        </span>
        {sublabel && (
          <span style={{color: C.faint, fontFamily: F.mono, fontSize: 11}}>{sublabel}</span>
        )}
      </header>
      {children}
    </section>
  );
}
