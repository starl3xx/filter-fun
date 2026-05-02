/// Audit H-6 (Phase 1, 2026-05-01) regression — CORS origin allow-list.
///
/// Pre-fix the indexer served zero CORS headers; production browser clients on
/// filter.fun + the docs subdomain reached the API only because they happened to be
/// on the same origin during dev. Post-fix the policy lives in `cors.ts` as a pure
/// `originAllowed(origin, cfg)` function so the route layer just plumbs it into
/// Hono's `cors` middleware.
import {describe, expect, it} from "vitest";

import {loadCorsConfigFromEnv, originAllowed} from "../../../src/api/cors.js";

describe("CORS origin allow-list (Audit H-6)", () => {
  describe("default allowed-origin policy", () => {
    const cfg = loadCorsConfigFromEnv({});

    it("filter.fun production origin is allowed", () => {
      expect(originAllowed("https://filter.fun", cfg)).toBe("https://filter.fun");
    });

    it("docs subdomain is allowed", () => {
      expect(originAllowed("https://docs.filter.fun", cfg)).toBe("https://docs.filter.fun");
    });

    it("localhost dev origins are allowed (web on :3000 + alt :3001)", () => {
      expect(originAllowed("http://localhost:3000", cfg)).toBe("http://localhost:3000");
      expect(originAllowed("http://localhost:3001", cfg)).toBe("http://localhost:3001");
    });

    it("an unrelated origin is denied (returns null)", () => {
      expect(originAllowed("https://evil.example.com", cfg)).toBeNull();
    });

    it("subtle variant of the allowed origin is denied (no looser substring match)", () => {
      // Pinned because `String.prototype.includes` would let
      // `https://attacker-filter.fun` slip through. The implementation must use
      // exact-equality on the allow-list entries.
      expect(originAllowed("https://attacker-filter.fun", cfg)).toBeNull();
      expect(originAllowed("http://filter.fun", cfg)).toBeNull(); // wrong protocol
    });

    it("empty origin string is denied", () => {
      expect(originAllowed("", cfg)).toBeNull();
    });
  });

  describe("env override", () => {
    it("CORS_ALLOWED_ORIGINS replaces the default list verbatim", () => {
      const cfg = loadCorsConfigFromEnv({
        CORS_ALLOWED_ORIGINS: "https://staging.filter.fun,https://preview.filter.fun",
      });
      expect(originAllowed("https://staging.filter.fun", cfg)).toBe("https://staging.filter.fun");
      expect(originAllowed("https://preview.filter.fun", cfg)).toBe("https://preview.filter.fun");
      // Default origins NOT inherited when env override is present.
      expect(originAllowed("https://filter.fun", cfg)).toBeNull();
    });

    it("trims whitespace + drops empty entries (commonly trailing-comma in shell exports)", () => {
      const cfg = loadCorsConfigFromEnv({
        CORS_ALLOWED_ORIGINS: " https://a.com , , https://b.com , ",
      });
      expect(originAllowed("https://a.com", cfg)).toBe("https://a.com");
      expect(originAllowed("https://b.com", cfg)).toBe("https://b.com");
    });

    it("empty CORS_ALLOWED_ORIGINS env value falls back to defaults", () => {
      const cfg = loadCorsConfigFromEnv({CORS_ALLOWED_ORIGINS: ""});
      expect(originAllowed("https://filter.fun", cfg)).toBe("https://filter.fun");
    });

    it("only-commas CORS_ALLOWED_ORIGINS env value falls back to defaults", () => {
      const cfg = loadCorsConfigFromEnv({CORS_ALLOWED_ORIGINS: ",,,"});
      expect(originAllowed("https://filter.fun", cfg)).toBe("https://filter.fun");
    });
  });

  it("origin echo, not wildcard, is the safer return shape on a match", () => {
    // Returning the matched origin (not "*") keeps the response origin-specific so
    // a cached response doesn't accidentally satisfy a different origin's preflight.
    const cfg = loadCorsConfigFromEnv({});
    expect(originAllowed("https://filter.fun", cfg)).toBe("https://filter.fun");
    expect(originAllowed("https://filter.fun", cfg)).not.toBe("*");
  });

  describe("exposeHeaders allow-list (Bugbot PR #61, Medium)", () => {
    // The CORS middleware is wired in src/api/index.ts (not in cors.ts — `index.ts`
    // owns the cors() call because it composes the route layer). This test grep's the
    // source for the exposeHeaders config so a regression that drops a header surfaces
    // as a test failure.
    //
    // Why custom headers need explicit exposure: per the Fetch spec, only CORS-
    // safelisted response headers (Cache-Control / Content-Language / Content-Length /
    // Content-Type / Expires / Last-Modified / Pragma) are readable by browser JS on
    // cross-origin responses. Without exposeHeaders, `RateLimit-Remaining` /
    // `Retry-After` / `X-Cache` are silently stripped from browser-visible responses,
    // breaking the rate-limit feedback loop.
    const fs = require("node:fs");
    const path = require("node:path");
    const SOURCE_PATH = path.resolve(__dirname, "../../../src/api/index.ts");
    const source: string = fs.readFileSync(SOURCE_PATH, "utf8");

    it("CORS config exposes RateLimit-Remaining (used by every GET response)", () => {
      expect(source).toContain('"RateLimit-Remaining"');
    });

    it("CORS config exposes Retry-After (used on 429 responses)", () => {
      expect(source).toContain('"Retry-After"');
    });

    it("CORS config exposes X-Cache (used on cached endpoint responses)", () => {
      expect(source).toContain('"X-Cache"');
    });

    it("exposeHeaders config block exists in the cors() call", () => {
      expect(source).toMatch(/exposeHeaders:\s*\[/);
    });
  });
});
