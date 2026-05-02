/// CORS configuration — Audit H-6 (Phase 1, 2026-05-01)
///
/// Pre-fix the indexer served zero CORS headers. Browser clients on filter.fun + the
/// docs subdomain reached the API only because they happened to be served over the
/// same origin during dev; production deploys would surface as silent network errors
/// in the browser ("blocked by CORS policy") with no obvious server-side trace.
///
/// This module owns the allow-list policy. The route layer wires it via Hono's `cors`
/// middleware; we expose `loadCorsConfigFromEnv` + `originAllowed` so the policy is
/// (a) overridable via env without a code deploy and (b) testable as a pure function
/// without a running Hono.

const DEFAULT_ALLOWED_ORIGINS: ReadonlyArray<string> = [
  "https://filter.fun",
  "https://docs.filter.fun",
  "http://localhost:3000", // web dev
  "http://localhost:3001", // web dev (alt port)
];

export interface CorsConfig {
  allowedOrigins: ReadonlyArray<string>;
}

/// Read `CORS_ALLOWED_ORIGINS` (comma-separated) if present; otherwise fall back to
/// `DEFAULT_ALLOWED_ORIGINS`. The env override exists so a production deploy can add
/// a new origin (e.g. a staging URL) without redeploying the indexer image.
///
/// Empty values in the env (e.g. `CORS_ALLOWED_ORIGINS=,,`) are dropped silently —
/// commas trailing the last entry are a common accident with shell `export`s.
export function loadCorsConfigFromEnv(env: Record<string, string | undefined> = process.env): CorsConfig {
  const raw = env.CORS_ALLOWED_ORIGINS;
  if (!raw) return {allowedOrigins: DEFAULT_ALLOWED_ORIGINS};
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parsed.length === 0) return {allowedOrigins: DEFAULT_ALLOWED_ORIGINS};
  return {allowedOrigins: parsed};
}

/// Pure origin-allow predicate. Returns the allowed origin string (the value Hono will
/// echo back in `Access-Control-Allow-Origin`) on a match, or `null` to deny. Returning
/// the matched origin (rather than `*`) is the safer default — it keeps the response
/// origin-specific so cached responses don't accidentally satisfy a different origin.
export function originAllowed(origin: string, cfg: CorsConfig): string | null {
  if (!origin) return null;
  return cfg.allowedOrigins.includes(origin) ? origin : null;
}
