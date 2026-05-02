import type {Metadata} from "next";
import {Bricolage_Grotesque, JetBrains_Mono} from "next/font/google";
import type {ReactNode} from "react";

import {Providers} from "./providers";
import "./globals.css";

/// ARENA_SPEC §2.1 / §2.2 mandates 5 Bricolage Grotesque weights — 400, 500, 600,
/// 700, 800. Phase 1 audit C-8 caught that 500 + 600 were missing here, causing
/// type roles T2 / T4 (and any other request for medium/semibold) to silently
/// fall back to the nearest loaded weight (likely 400 or 700) and break visual
/// hierarchy across every page that uses the display font. Add ALL 5 — removing
/// any of the spec-mandated weights from this array is a regression.
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-display",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500", "700", "800"],
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
