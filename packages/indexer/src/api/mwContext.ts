/// MwContext adapter — Audit H-3 (Phase 1, 2026-05-01)
///
/// Every route in `src/api/index.ts` previously took the Ponder `Context` and ran
/// `const mw = c as unknown as MwContext;` — five sites, no runtime check, no failure
/// mode if Ponder's Context shape ever drifted (a missing `.var`, `.req.url`, etc.)
/// would only surface deep inside middleware.
///
/// This adapter consolidates the cast behind a single function with a runtime shape
/// assertion. The cast is still there — `MwContext` is structurally a strict subset of
/// what Hono/Ponder hand back, and a perfect TypeScript intersection would require
/// pulling in `@hono/node-server`'s context types as a build-time dep — but the bound
/// is now load-bearing: a Ponder upgrade that breaks the adapter throws on the very
/// first request rather than silently corrupting requests downstream.
///
/// Usage:
///
///   ponder.get("/season", async (c) => {
///     const mw = toMwContext(c);  // throws if shape changed
///     // ... mw is typed as MwContext
///   });

import type {MwContext} from "./middleware.js";

/// Shape-validate `c` against the structural surface every route depends on, then
/// return it typed as `MwContext`. The check is intentionally minimal — it's the
/// difference between "Ponder shipped a major refactor" (this throws) and "we've
/// been forwarding stale shape assumptions for months" (silent drift).
///
/// The thrown error names the missing surface so the operator can match it against
/// Ponder's release notes without reading the indexer's middleware module first.
export function toMwContext(c: unknown): MwContext {
  if (typeof c !== "object" || c === null) {
    throw new Error("toMwContext: context is not an object");
  }
  const probe = c as Record<string, unknown>;

  // `req` carries the URL + header reader — every middleware helper relies on it.
  // We don't require `req.url` to BE a string here (constructor of URL handles that
  // upstream); the adapter only proves the surface exists.
  if (typeof probe.req !== "object" || probe.req === null) {
    throw new Error("toMwContext: Ponder Context shape changed — missing .req");
  }
  const req = probe.req as Record<string, unknown>;
  if (typeof req.url !== "string") {
    throw new Error("toMwContext: Ponder Context shape changed — missing .req.url");
  }
  if (typeof req.header !== "function") {
    throw new Error("toMwContext: Ponder Context shape changed — missing .req.header");
  }

  // `header()` is the response-side header writer.
  if (typeof probe.header !== "function") {
    throw new Error("toMwContext: Ponder Context shape changed — missing .header");
  }

  // `json()` builds the response body. No way to validate the closure return type at
  // runtime; existence is the strongest assertion we can make.
  if (typeof probe.json !== "function") {
    throw new Error("toMwContext: Ponder Context shape changed — missing .json");
  }

  return c as MwContext;
}
