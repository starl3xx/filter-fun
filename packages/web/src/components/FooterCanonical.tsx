/// Canonical channels footer — spec §32.5 surface (Epic 1.28).
///
/// Sits at the bottom of every user-facing page (`/`, `/launch`, `/graveyard`,
/// `/w/[address]`, `/p/[identifier]`, …). NOT rendered on the operator console
/// (`/operator`) or the creator admin console (`/admin/[token]`) — those are
/// focused workflow surfaces with a different audience.
///
/// Channels enumerated here are the LOCKED canonical set (spec §32.5):
///   - filter.fun (current product)
///   - docs.filter.fun (long-form docs)
///   - api.filter.fun (indexer custom domain — Epic 2.12)
///   - X @filterdotfun
///   - GitHub starl3xx/filter-fun
///   - email starl3xx@filter.fun (NOT security@…; spec §32.5 lock)
///
/// Tagline is the locked brand kit string ("Get filtered or get funded ▼").
/// The triangle is the literal U+25BC glyph — never the U+1F53B emoji
/// (brand kit v1.0 + spec §32.4; Epic 1.28 closes the wire-payload gap and
/// `npm run lint:brand-glyph` enforces it in CI).

import {C, F} from "@/lib/tokens";

export type CanonicalChannel = {
  href: string;
  label: string;
  rel?: string;
};

/// Canonical channels in display order. Exported so tests can assert the
/// shape stays stable across releases — a regression on the email or the
/// GitHub URL is a brand-kit violation, not a layout choice.
export const CANONICAL_CHANNELS: ReadonlyArray<CanonicalChannel> = [
  {href: "https://filter.fun", label: "filter.fun"},
  {href: "https://docs.filter.fun", label: "docs.filter.fun"},
  {href: "https://api.filter.fun", label: "api.filter.fun"},
  {href: "https://x.com/filterdotfun", label: "@filterdotfun", rel: "noopener noreferrer"},
  {href: "https://github.com/starl3xx/filter-fun", label: "github.com/starl3xx/filter-fun", rel: "noopener noreferrer"},
  {href: "mailto:starl3xx@filter.fun", label: "starl3xx@filter.fun"},
];

export const CANONICAL_TAGLINE = "Get filtered or get funded ▼";

export function FooterCanonical() {
  return (
    <footer
      data-testid="footer-canonical"
      style={{
        position: "relative",
        zIndex: 1,
        marginTop: 32,
        padding: "20px 22px 28px",
        borderTop: `1px solid ${C.line}`,
        background: "rgba(20, 8, 40, 0.45)",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 14,
      }}
    >
      <span
        style={{
          fontFamily: F.display,
          fontSize: 12,
          color: C.faint,
          letterSpacing: "0.04em",
        }}
      >
        {CANONICAL_TAGLINE}
      </span>
      <ul
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "6px 16px",
          margin: 0,
          padding: 0,
          listStyle: "none",
        }}
      >
        {CANONICAL_CHANNELS.map((c) => {
          const isExternal = c.href.startsWith("http");
          return (
            <li key={c.href} style={{margin: 0}}>
              <a
                href={c.href}
                {...(isExternal ? {target: "_blank", rel: c.rel ?? "noopener noreferrer"} : {})}
                style={{
                  fontFamily: F.mono,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  color: C.dim,
                  textDecoration: "none",
                  transition: "color 0.15s",
                }}
              >
                {c.label}
              </a>
            </li>
          );
        })}
      </ul>
    </footer>
  );
}
