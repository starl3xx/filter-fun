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
    // directives that matter: default-src 'self', no 'unsafe-eval'
    // outside wasm, frame-ancestors 'none', explicit Pinata in
    // connect-src.
    expect(src).toMatch(/key\s*:\s*["']Content-Security-Policy["']/);
    expect(src).toMatch(/default-src\s+'self'/);
    expect(src).toMatch(/script-src\s+'self'\s+'wasm-unsafe-eval'/);
    expect(src).toMatch(/frame-ancestors\s+'none'/);
    // Use `[\s\S]*?` (lazy any-char) so the regex matches across the
    // 'self' single-quotes, the ${indexerUrl} interpolation, and any
    // newlines in the template literal between `connect-src` and the
    // api.pinata.cloud token.
    expect(src).toMatch(/connect-src[\s\S]*?api\.pinata\.cloud/);
    // Negative: must not allow `unsafe-eval` outside the wasm form, and
    // must not allow `*` as default-src.
    expect(src).not.toMatch(/script-src[^"']*'unsafe-eval'(?!.*wasm)/);
    expect(src).not.toMatch(/default-src\s+\*/);
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
