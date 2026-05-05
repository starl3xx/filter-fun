/// Regression for the `fetchJson` error-message status parser
/// (bugbot M PR #102 pass-7).
///
/// `fetchJson` throws `new Error("<url> → <status>")` on non-2xx. The page
/// at `/p/[identifier]` uses `fetchJsonErrorStatus` to recover the code so
/// it can branch into the 404 "no profile here" state. The original
/// implementation matched `\b(\d{3})\b` which picks up the FIRST 3-digit
/// run anywhere — for a numeric Epic 1.24 username like `123` the URL
/// segment matched before the actual status code. The fix anchors to the
/// terminal `→ <status>` segment.

import {describe, expect, it} from "vitest";

import {fetchJsonErrorStatus} from "@/lib/arena/api";

describe("fetchJsonErrorStatus (PR #102 pass-7 regression)", () => {
  it("returns 404 when the URL contains no digits", () => {
    const err = new Error("http://indexer.local/profile/starbreaker → 404");
    expect(fetchJsonErrorStatus(err)).toBe(404);
  });

  it("returns the trailing status, not a numeric username embedded in the URL", () => {
    // The bug: the old regex returned 123 (the username) instead of 404.
    const err = new Error("http://indexer.local/profile/123 → 404");
    expect(fetchJsonErrorStatus(err)).toBe(404);
  });

  it("returns the trailing status when the URL contains a port number", () => {
    const err = new Error("http://indexer.local:42069/profile/abc → 503");
    expect(fetchJsonErrorStatus(err)).toBe(503);
  });

  it("returns null for a non-Error rejection", () => {
    expect(fetchJsonErrorStatus("nope")).toBe(null);
    expect(fetchJsonErrorStatus(undefined)).toBe(null);
  });

  it("returns null when no `→ <3-digit>` suffix is present", () => {
    expect(fetchJsonErrorStatus(new Error("network failure"))).toBe(null);
    // No arrow — must NOT match a stray 3-digit run elsewhere.
    expect(fetchJsonErrorStatus(new Error("got 404 maybe"))).toBe(null);
  });
});
