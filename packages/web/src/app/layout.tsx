import type {Metadata} from "next";
import {Bricolage_Grotesque, JetBrains_Mono} from "next/font/google";
import type {ReactNode} from "react";

import {Providers} from "./providers";
import "./globals.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["400", "700", "800"],
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
