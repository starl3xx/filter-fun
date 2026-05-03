/// POST /api/metadata
///
/// Receives the launch-form fields, validates server-side, builds the
/// metadata document, pins it (via Pinata if configured, else filesystem),
/// and returns the URI the form passes to `FilterLauncher.launchToken(...)`.
///
/// Two-tier strategy is documented in `lib/launch/storage.ts`:
///   - PINATA_JWT set        → ipfs://<cid> (preferred)
///   - METADATA_STORE_DIR    → self-hosted https://…/api/metadata/<slug>
///   - Neither               → fail loudly with 500
///
/// We re-validate input here even though the form does the same thing on
/// the client — the contract stores `metadataURI` opaquely, so the API is
/// the only enforcement layer that survives a hostile client.

// Audit M-Web-7 (Phase 1, 2026-05-02): pin this module to the server bundle
// so that an accidental client-side import (e.g. a future shared util that
// re-exports from this route) trips at build time instead of leaking
// PINATA_JWT through to the browser bundle. Next.js routes are server-only
// by default, but the explicit import upgrades the leak from "silent code
// review miss" to "build-time error".
import "server-only";

import {NextResponse, type NextRequest} from "next/server";

import {
  activeBackend,
  MetadataStorageError,
  pinToFs,
  pinToPinata,
} from "@/lib/launch/storage";
import {
  buildMetadataDoc,
  coerceLaunchFields,
  validateLaunchFields,
} from "@/lib/launch/validation";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({error: "invalid json"}, {status: 400});
  }

  // Shape-coerce before validating — `req.json()` returns `unknown` and a
  // hostile client could send `{}` or `{name: 42}`, which would crash
  // `.trim()` inside the validator and bypass the structured 400 response.
  const body = coerceLaunchFields(raw);
  const errors = validateLaunchFields(body);
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({error: "validation failed", fieldErrors: errors}, {status: 400});
  }

  // Audit M-Sec-2 (Phase 1, 2026-05-03): the regex check in
  // `validateLaunchFields` only confirms `imageUrl` STARTS with `https://`.
  // It can't detect the post-fetch trick where an attacker registers an
  // `https://attacker.example/img.png` URL that 302-redirects to
  // `data:text/html,<script>…</script>` or to a non-HTTPS host. Server-
  // side HEAD-check the URL with `redirect: "manual"` so we see the raw
  // response and can reject any 3xx before the metadata gets pinned.
  const imageCheck = await checkImageUrlSafe(body.imageUrl);
  if (imageCheck.error) {
    return NextResponse.json(
      {error: "validation failed", fieldErrors: {imageUrl: imageCheck.error}},
      {status: 400},
    );
  }

  const backend = activeBackend();
  if (backend === "none") {
    return NextResponse.json(
      {
        error:
          "metadata storage not configured: set PINATA_JWT (preferred) or METADATA_STORE_DIR for the filesystem fallback",
      },
      {status: 500},
    );
  }

  const doc = buildMetadataDoc(body);

  try {
    const ref = backend === "pinata" ? await pinToPinata(doc) : await pinToFs(doc, originOf(req));
    return NextResponse.json({uri: ref.uri, backend: ref.backend});
  } catch (err) {
    const status = err instanceof MetadataStorageError ? err.status : 500;
    const message = err instanceof Error ? err.message : "pin failed";
    return NextResponse.json({error: message}, {status});
  }
}

function originOf(req: NextRequest): string {
  const fromEnv = process.env.METADATA_PUBLIC_URL;
  if (fromEnv) return fromEnv;
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

/// Audit M-Sec-2 (Phase 1, 2026-05-03): server-side image URL safety check.
///
/// The client / `validateLaunchFields` regex confirms the URL starts with
/// `https://`, but a hostile creator can register an `https://…` URL that
/// 302-redirects to a non-HTTPS host or to a `data:` scheme. Once that
/// redirect target lands in the pinned metadata, downstream renderers
/// (token cards, OG previews) might follow the chain and surface
/// attacker-controlled content. HEAD-check with `redirect: "manual"` so
/// we see the raw response, then:
///   - 200/204/206 → URL resolves directly, accept.
///   - 3xx with a `Location` that doesn't start `https://` → reject.
///   - 3xx with a `Location` that DOES start `https://` → accept (we
///     don't recursively chase — one hop is enough to detect the
///     `https → data:` / `https → http:` shapes the audit cared about,
///     and chasing further opens an SSRF / latency budget the route
///     can't afford on a per-launch handler).
///   - Network failure / timeout → reject (the URL must resolve before
///     we mint metadata that depends on it).
///
/// 7-second timeout via `AbortSignal.timeout` keeps a slow / hung remote
/// from stalling the launch flow indefinitely. Production launchers
/// already wait on Pinata pin (~2-3s typical), so the budget here is
/// generous.
async function checkImageUrlSafe(url: string): Promise<{error: string | null}> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {error: "Image URL must be a well-formed https URL."};
  }
  if (parsed.protocol !== "https:") {
    return {error: "Image URL must start with https://."};
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(7_000),
    });
  } catch {
    return {error: "Image URL did not resolve. Confirm the link is reachable, then retry."};
  }
  // 200-class: direct OK. Allow 200/204/206 explicitly (some CDNs return
  // 206 to HEAD).
  if (res.status === 200 || res.status === 204 || res.status === 206) {
    return {error: null};
  }
  // 3xx: inspect the Location header. Reject anything that isn't
  // a fresh https://… URL.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location") ?? "";
    if (!loc) {
      return {error: "Image URL redirects but no destination given. Pick a direct image URL."};
    }
    try {
      const next = new URL(loc, url);
      if (next.protocol !== "https:") {
        return {
          error: `Image URL redirects to a non-https destination (${next.protocol}). Use a direct https link.`,
        };
      }
      return {error: null};
    } catch {
      return {error: "Image URL redirect destination is not a valid URL."};
    }
  }
  // 4xx / 5xx: the URL is broken. Reject.
  return {
    error: `Image URL returned status ${res.status}. Confirm the link is publicly reachable.`,
  };
}
