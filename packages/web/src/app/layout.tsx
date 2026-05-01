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
  title: "filter.fun",
  description: "Get filtered or get funded ▼",
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
