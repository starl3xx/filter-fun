/// Shared spectator-surface primitives used by `/graveyard/[address]` and
/// `/w/[identifier]`. Bugbot PR #103 pass-21 dedup — the two pages defined
/// identical `Panel` and `SideLink` components inline, which would have
/// drifted as styling evolved.

import Link from "next/link";

import {C, F} from "@/lib/tokens";

export function Panel({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <div
      style={{
        padding: 16,
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: C.dim,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontFamily: F.mono,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

export function SideLink({title, href, sub}: {title: string; href: string; sub: string}) {
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 12,
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        textDecoration: "none",
        color: C.text,
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: C.dim,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontFamily: F.mono,
          fontWeight: 600,
        }}
      >
        {title} →
      </span>
      <span style={{fontSize: 13, color: C.text, fontFamily: F.mono}}>{sub}</span>
    </Link>
  );
}
