import path from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages compile from source rather than via prebuilt dist; tell Next to
  // run them through swc so it doesn't choke on TS imports across package boundaries.
  transpilePackages: ["@filter-fun/oracle", "@filter-fun/scheduler", "@filter-fun/scoring"],
  // Standalone bundles a self-contained .next/standalone/server.js with traced node_modules
  // so the runtime image doesn't need npm install. tracingRoot points at the monorepo root
  // so hoisted workspace deps get included.
  output: "standalone",
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  // Workspace packages use NodeNext-style ".js" import specifiers that resolve to .ts
  // sources. Without this, webpack errors with "Can't resolve './foo.js'" because the
  // physical file is foo.ts. Standard pattern for ESM TS in monorepos.
  webpack(config) {
    config.resolve.extensionAlias = {
      ".js": [".js", ".ts", ".tsx"],
      ".mjs": [".mjs", ".mts"],
    };
    return config;
  },
  // The arena IS the homepage. /arena 302s to / so external links and
  // muscle-memory still resolve. Query strings (e.g. `?token=…` from /launch)
  // are preserved by Next's redirect handling.
  async redirects() {
    return [
      {source: "/arena", destination: "/", permanent: false},
    ];
  },
  // Audit H-Sec-CSP (Phase 1, 2026-05-03): pre-fix the app shipped with no
  // CSP / X-Frame-Options / X-Content-Type-Options headers. With wagmi
  // injecting wallet RPCs, an XSS injection could exfiltrate connected-
  // wallet state or mutate transactions before signing. The directives
  // below are the minimum-viable lockdown for the current surface:
  //
  //   default-src 'self'                — deny everything not whitelisted
  //   script-src 'self' 'wasm-unsafe-eval'
  //                                      — wagmi + viem use Wasm crypto
  //                                        primitives at signing time;
  //                                        without 'wasm-unsafe-eval' the
  //                                        wallet flow breaks. Keep this
  //                                        narrow — no 'unsafe-inline' /
  //                                        'unsafe-eval'.
  //   connect-src 'self' INDEXER_URL https://*.base.org
  //               https://*.publicnode.com wss://*.walletconnect.{com,org}
  //               https://*.walletconnect.{com,org}
  //                                      — the indexer is the SSE / REST
  //                                        surface; the *.base.org and
  //                                        *.publicnode.com hosts cover the
  //                                        viem public-RPC fallback for both
  //                                        chains. WalletConnect needs both
  //                                        wss:// (relay) and https://
  //                                        (project metadata) hosts at
  //                                        pair time. Deploys that override
  //                                        NEXT_PUBLIC_BASE_RPC_URL to a
  //                                        different provider must add that
  //                                        host here too.
  //                                        Bugbot fix on PR #80: Pinata is
  //                                        deliberately NOT in connect-src.
  //                                        Pinata is reached only by the
  //                                        server-side `/api/metadata` route
  //                                        (`storage.ts` carries
  //                                        `import "server-only"`), so the
  //                                        browser never connects there
  //                                        directly. Including it would
  //                                        widen the policy without enabling
  //                                        any real-world request and
  //                                        contradicts the L-Sec-2 doc note
  //                                        in `lib/launch/storage.ts`.
  //   style-src 'self' 'unsafe-inline'   — every component uses inline
  //                                        styles via React style props
  //                                        (the project's chosen styling
  //                                        story); 'unsafe-inline' is
  //                                        load-bearing for that pattern.
  //                                        Migrating off inline styles
  //                                        would let us drop this; not in
  //                                        scope for Phase 1.
  //   font-src 'self' data:              — next/font self-hosts via /_next
  //                                        (no Google fetch at runtime —
  //                                        verified by L-Sec-1 — but the
  //                                        data: scheme is needed for some
  //                                        embedded font fallbacks).
  //   img-src 'self' https: data:        — token avatars are inline SVG
  //                                        glyphs today (not raster) but
  //                                        the wallet modals use https /
  //                                        data: image sources.
  //   frame-ancestors 'none'             — paired with X-Frame-Options:
  //                                        DENY for clickjacking defense.
  //   base-uri 'self'                    — prevents <base href="…"> hijack.
  //   form-action 'self'                 — only the in-app /api routes.
  //
  // The non-CSP headers (X-Frame-Options DENY, X-Content-Type-Options
  // nosniff, Referrer-Policy strict-origin-when-cross-origin, Permissions-
  // Policy locking down camera/mic/geo) are belt-and-suspenders. Applied
  // to every route with `source: "/(.*)"` — the API routes return their
  // own JSON content-type and don't conflict with the page-level CSP.
  async headers() {
    const indexerUrl = process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:42069";
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      `connect-src 'self' ${indexerUrl} https://*.base.org https://*.publicnode.com wss://*.walletconnect.com wss://*.walletconnect.org https://*.walletconnect.com https://*.walletconnect.org`,
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' https: data:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
    return [
      {
        source: "/(.*)",
        headers: [
          {key: "Content-Security-Policy", value: csp},
          {key: "X-Frame-Options", value: "DENY"},
          {key: "X-Content-Type-Options", value: "nosniff"},
          {key: "Referrer-Policy", value: "strict-origin-when-cross-origin"},
          {key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()"},
        ],
      },
    ];
  },
};

export default nextConfig;
