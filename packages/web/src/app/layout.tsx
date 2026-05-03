import type {Metadata} from "next";
import {Bricolage_Grotesque, JetBrains_Mono} from "next/font/google";
import type {ReactNode} from "react";

import {Providers} from "./providers";
import "./globals.css";

/// ARENA_SPEC §2.1 / §2.2 mandates 5 Bricolage Grotesque weights — 400, 500, 600,
/// 700, 800. Phase 1 audit C-8 caught that 500 + 600 were missing here, causing
/// type roles T2 / T4 (and any other request for medium/semibold) to silently
/// fall back to the nearest loaded weight (likely 400 or 700) and break visual
/// hierarchy across every page that uses the display font.
///
/// Audit M-Brand-1 (Phase 1, 2026-05-03): the brand kit + the 15+ inline
/// `fontWeight: 900` sites across the codebase were requesting a Black weight
/// the Google distribution of Bricolage Grotesque does NOT publish — the
/// available weights are 200/300/400/500/600/700/800 (verified by `next/font`
/// at build time, which throws "Unknown weight `900` for font `Bricolage
/// Grotesque`"). Pre-fix the browser silently substituted 800 for the 900
/// requests; post-fix all inline `fontWeight: 900` sites are migrated to
/// `fontWeight: 800` so code-truth matches rendered-truth (drops the silent
/// fallback). The 5-weight import stays as-is. Removing ANY of the 5
/// spec-mandated weights is a regression.
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-display",
});

/// ARENA_SPEC §2.1 mandates 4 JetBrains Mono weights — 400, 500, 600, 700.
/// Phase 1 audit M-Arena-1 caught that 400 + 600 were missing AND that 800 was
/// being loaded (not in spec): the previous set was 500/700/800. Mono surfaces
/// (countdowns, prices, RateLimit-Remaining footer chip, table tabular-nums
/// columns) silently fall back to the nearest loaded weight when a non-loaded
/// weight is requested, which broke type-role hierarchy across every mono
/// surface. Removing any spec-mandated weight here — or adding one not in spec
/// — is a regression.
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  // `metadataBase` lets Next resolve relative `openGraph.url` / image URLs per-route. We
  // intentionally omit a hardcoded `openGraph.url` so child pages inherit the correct
  // absolute URL from their pathname; setting it here would pin every page's `og:url` to
  // the homepage.
  metadataBase: new URL("https://filter.fun"),
  title: {
    default: "filter.fun",
    template: "%s · filter.fun",
  },
  description: "Get filtered or get funded ▼",
  openGraph: {
    type: "website",
    siteName: "filter.fun",
    title: "filter.fun",
    description: "Get filtered or get funded ▼",
  },
  // Card type is `summary` (small icon + text) — `summary_large_image` requires an OG
  // image asset; the launch surface and arena page don't have one yet. Bump to
  // `summary_large_image` once an OG image lands under `public/og.png` (or per-route via
  // `generateMetadata`) — Twitter falls back to `summary` when no image is provided, but
  // declaring it explicitly is clearer.
  twitter: {
    card: "summary",
    site: "@filterdotfun",
    creator: "@filterdotfun",
    title: "filter.fun",
    description: "Get filtered or get funded ▼",
  },
};

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
