/// PolishSecurityPassTest — Audit polish pass (Phase 1, 2026-05-03)
///
/// Bundled regressions for the code-touching items in the security polish PR.
/// Each test maps to one finding in
/// `audit/2026-05-PHASE-1-AUDIT/security.md` so a future revert that drops
/// the change surfaces with the audit ID in the failure label.
///
/// Findings covered (CODE only — DOC / CLOSE-AS-PASS rows are pinned by the
/// status notes in security.md, not by this suite):
///   - H-Sec-CSP: `next.config.mjs` ships an `async headers()` returning
///     CSP + X-Frame-Options + X-Content-Type-Options + Referrer-Policy +
///     Permissions-Policy on every route.
///   - M-Sec-2: `/api/metadata` route HEAD-checks the image URL with
///     `redirect: "manual"` and rejects non-https / data: redirect
///     destinations before pinning.
import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {POST} from "../../src/app/api/metadata/route.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
function readSource(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf-8");
}

type MetaResponse = {
  uri?: string;
  backend?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
};

const validBody = {
  name: "Filtermaxx",
  ticker: "MAXX",
  description: "A token built to survive the filter and fund the winner.",
  imageUrl: "https://cdn.example.com/logo.png",
};

function makePostRequest(body: unknown, url = "https://filter.fun/api/metadata"): Request {
  return new Request(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
  });
}

// H-Sec-CSP -----------------------------------------------------------------
//
// Pre-fix: next.config.mjs only had `redirects()`. Post-fix: an
// `async headers()` returns CSP + clickjacking / MIME-sniff / referrer /
// permissions headers on every route. Source-grep test because the
// next.config.mjs is a config module — running it through the Next
// runtime to assert headers would require a full dev-server boot, which
// isn't worth the test budget for a pin.
describe("H-Sec-CSP: next.config.mjs ships security headers on every route", () => {
  const src = readSource("next.config.mjs");

  it("exports an async headers() function", () => {
    expect(src).toMatch(/async\s+headers\s*\(\s*\)\s*\{/);
  });

  it("the headers() block applies to every route via `source: \"/(.*)\"`", () => {
    expect(src).toMatch(/source\s*:\s*["']\/\(\.\*\)["']/);
  });

  it("includes a Content-Security-Policy header with the load-bearing directives", () => {
    // The full CSP value is built dynamically (it interpolates
    // INDEXER_URL), so we can't pin the entire string. Pin the
    // directives that matter: default-src 'self', no standalone
    // 'unsafe-eval' (only the 'wasm-unsafe-eval' form), frame-
    // ancestors 'none', and Pinata explicitly NOT in connect-src
    // (server-only, per the bugbot fix on PR #80 — including it
    // would widen the policy without enabling any real-world request).
    expect(src).toMatch(/key\s*:\s*["']Content-Security-Policy["']/);
    expect(src).toMatch(/default-src\s+'self'/);
    expect(src).toMatch(/script-src\s+'self'\s+'wasm-unsafe-eval'/);
    expect(src).toMatch(/frame-ancestors\s+'none'/);
    // Bugbot fix on PR #80 (round 3): `'unsafe-inline'` in script-src is
    // load-bearing for Next.js 14 App Router (RSC flight-data inline
    // scripts at hydration). Pin its presence so a future "tighten the
    // CSP" pass that drops it without setting up nonce middleware fails
    // here loudly instead of silently breaking client-side hydration in
    // production (no navigation, no wallet connect). When the Phase 2
    // nonce-middleware migration lands, this assertion flips to require
    // a nonce attribute scheme and 'unsafe-inline' goes away.
    expect(src, "script-src must include 'unsafe-inline' until Phase 2 nonce middleware lands").toMatch(/script-src\s+'self'\s+'wasm-unsafe-eval'\s+'unsafe-inline'/);
    // Bugbot fix on PR #80: the previous regex
    // `/script-src[^"']*'unsafe-eval'(?!.*wasm)/` was dead — `[^"']*`
    // halts at the first `'self'` quote (so it can't reach a later
    // `'unsafe-eval'`), and `(?!.*wasm)` always fails because the
    // file always contains `'wasm-unsafe-eval'`. Use a negative
    // lookbehind instead: match `'unsafe-eval'` only when NOT
    // immediately preceded by `wasm-`. This catches a regression that
    // adds standalone `'unsafe-eval'` while still allowing the
    // spec-correct `'wasm-unsafe-eval'` form. Scoped to the literal
    // `csp = [...]` array so the doc-comment phrase "no 'unsafe-eval'"
    // (which we WANT in the source as a warning to maintainers) is
    // not flagged.
    const cspArray = src.match(/const\s+csp\s*=\s*\[([\s\S]*?)\]\.join/)?.[1] ?? "";
    expect(cspArray.length, "could not locate `const csp = [...]` array in next.config.mjs").toBeGreaterThan(0);
    expect(cspArray, "CSP array contains standalone 'unsafe-eval' (only 'wasm-unsafe-eval' is allowed)").not.toMatch(/(?<!wasm-)'unsafe-eval'/);
    expect(cspArray).not.toMatch(/default-src\s+\*/);
    // Bugbot fix on PR #80 (round 3): the previous connect-src regex
    // `/connect-src[^`'\n]*/` repeated the same character-class trap I
    // already fixed for the script-src pin in round 2 — `[^`'\n]*`
    // excludes single quotes, so the match halted at the first `'` in
    // `'self'`, capturing only `"connect-src "` (12 chars) and
    // making `not.toMatch(/api\.pinata\.cloud/)` pass trivially. The
    // connect-src directive is the ONE template literal in the csp
    // array (because it interpolates `${indexerUrl}`), so we can
    // reliably bound it by its backticks: the match runs from the
    // opening backtick to the next backtick. Scoped to cspArray so
    // the doc-comment in next.config.mjs that mentions Pinata-by-name
    // (explaining WHY it's excluded) is not flagged.
    const connectSrcLine = cspArray.match(/`connect-src[^`]*`/)?.[0] ?? "";
    expect(connectSrcLine.length, "could not locate `connect-src ...` template literal inside the csp array").toBeGreaterThan("`connect-src `".length);
    expect(connectSrcLine, "connect-src directive must not include api.pinata.cloud (server-only)").not.toMatch(/api\.pinata\.cloud/);
  });

  it("includes the four non-CSP defense headers (X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy)", () => {
    expect(src).toMatch(/key\s*:\s*["']X-Frame-Options["'][^}]*value\s*:\s*["']DENY["']/);
    expect(src).toMatch(/key\s*:\s*["']X-Content-Type-Options["'][^}]*value\s*:\s*["']nosniff["']/);
    expect(src).toMatch(/key\s*:\s*["']Referrer-Policy["']/);
    expect(src).toMatch(/key\s*:\s*["']Permissions-Policy["']/);
  });
});

// M-Sec-2 -------------------------------------------------------------------
//
// Pre-fix: imageUrl was only regex-checked for `https://` prefix.
// Post-fix: server-side HEAD-check with `redirect: "manual"` rejects
// 3xx redirects to non-https / data: schemes before pinning.
describe("M-Sec-2: /api/metadata HEAD-checks the image URL and rejects unsafe redirect destinations", () => {
  let storeDir = "";

  beforeEach(async () => {
    const {mkdtemp} = await import("node:fs/promises");
    const {tmpdir} = await import("node:os");
    storeDir = await mkdtemp(path.join(tmpdir(), "ff-meta-perf-"));
    delete process.env.PINATA_JWT;
    delete process.env.METADATA_PUBLIC_URL;
    process.env.METADATA_STORE_DIR = storeDir;
  });

  afterEach(async () => {
    if (storeDir) {
      const {rm} = await import("node:fs/promises");
      await rm(storeDir, {recursive: true, force: true});
    }
    delete process.env.METADATA_STORE_DIR;
    delete process.env.PINATA_JWT;
    delete process.env.METADATA_PUBLIC_URL;
    storeDir = "";
    vi.restoreAllMocks();
  });

  it("accepts a 200-OK image URL", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "HEAD" && url.startsWith("https://cdn.example.com/")) {
        return new Response(null, {status: 200});
      }
      throw new Error(`unmocked: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch);
    const res = await POST(makePostRequest(validBody) as never);
    expect(res.status).toBe(200);
  });

  it("rejects an image URL that 302-redirects to a `data:` scheme", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "HEAD" && url.startsWith("https://cdn.example.com/")) {
        return new Response(null, {
          status: 302,
          headers: {Location: "data:text/html,<script>alert(1)</script>"},
        });
      }
      throw new Error(`unmocked: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch);
    const res = await POST(makePostRequest(validBody) as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as MetaResponse;
    expect(json.fieldErrors?.imageUrl).toMatch(/non-https/i);
  });

  it("rejects an image URL that 301-redirects to plain http://", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "HEAD" && url.startsWith("https://cdn.example.com/")) {
        return new Response(null, {
          status: 301,
          headers: {Location: "http://attacker.example/img.png"},
        });
      }
      throw new Error(`unmocked: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch);
    const res = await POST(makePostRequest(validBody) as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as MetaResponse;
    expect(json.fieldErrors?.imageUrl).toMatch(/non-https/i);
  });

  it("accepts an image URL that 302-redirects to another https:// host (one hop allowed)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "HEAD" && url.startsWith("https://cdn.example.com/")) {
        return new Response(null, {
          status: 302,
          headers: {Location: "https://cdn-mirror.example.com/logo.png"},
        });
      }
      throw new Error(`unmocked: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch);
    const res = await POST(makePostRequest(validBody) as never);
    expect(res.status).toBe(200);
  });

  it("rejects an image URL whose HEAD returns 404 / 5xx", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "HEAD" && url.startsWith("https://cdn.example.com/")) {
        return new Response(null, {status: 404});
      }
      throw new Error(`unmocked: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch);
    const res = await POST(makePostRequest(validBody) as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as MetaResponse;
    expect(json.fieldErrors?.imageUrl).toMatch(/status 404/i);
  });

  it("rejects an image URL that fails to resolve (network error)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "HEAD" && url.startsWith("https://cdn.example.com/")) {
        throw new Error("ENOTFOUND cdn.example.com");
      }
      throw new Error(`unmocked: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch);
    const res = await POST(makePostRequest(validBody) as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as MetaResponse;
    expect(json.fieldErrors?.imageUrl).toMatch(/did not resolve/i);
  });
});
