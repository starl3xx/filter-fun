/// Audit H-3 (Phase 1, 2026-05-01) regression — MwContext adapter.
///
/// Pre-fix every route ran `const mw = c as unknown as MwContext;` — five sites,
/// no runtime check. A Ponder upgrade that drops or renames `.req`/`.req.url`/
/// `.req.header`/`.header`/`.json` would silently corrupt requests.
///
/// Post-fix `toMwContext(c)` validates the surface and throws with a named field
/// on shape drift, so a Ponder break surfaces on the very first request rather
/// than as silent middleware misbehaviour.
import {describe, expect, it} from "vitest";

import {toMwContext} from "../../../src/api/mwContext.js";

function validContext() {
  return {
    req: {
      url: "http://localhost:42069/season",
      method: "GET",
      path: "/season",
      header: (_n: string) => undefined,
    },
    header: (_n: string, _v: string) => {},
    json: (_b: unknown, _s?: number) => new Response(),
  };
}

describe("toMwContext (Audit H-3)", () => {
  it("returns the context typed as MwContext when shape is valid", () => {
    const out = toMwContext(validContext());
    expect(out).toBeDefined();
    // Sanity: the returned reference still behaves like a MwContext.
    expect(typeof out.json).toBe("function");
    expect(typeof out.req.url).toBe("string");
  });

  it("throws when context is null", () => {
    expect(() => toMwContext(null)).toThrow(/not an object/);
  });

  it("throws when context is not an object", () => {
    expect(() => toMwContext("a string")).toThrow(/not an object/);
    expect(() => toMwContext(42)).toThrow(/not an object/);
  });

  it("throws when .req is missing — names the missing surface", () => {
    const c = validContext() as Record<string, unknown>;
    delete c.req;
    expect(() => toMwContext(c)).toThrow(/missing \.req/);
  });

  it("throws when .req.url is missing", () => {
    const c = validContext() as Record<string, unknown>;
    (c.req as Record<string, unknown>).url = undefined;
    expect(() => toMwContext(c)).toThrow(/missing \.req\.url/);
  });

  it("throws when .req.method is missing", () => {
    // Bugbot PR #95 round 5 (Medium): operator-auth binds the signed
    // message body's `action:` field to `${method} ${path}`, so the adapter
    // now requires both fields exist on the underlying Ponder context.
    const c = validContext() as Record<string, unknown>;
    (c.req as Record<string, unknown>).method = undefined;
    expect(() => toMwContext(c)).toThrow(/missing \.req\.method/);
  });

  it("throws when .req.path is missing", () => {
    const c = validContext() as Record<string, unknown>;
    (c.req as Record<string, unknown>).path = undefined;
    expect(() => toMwContext(c)).toThrow(/missing \.req\.path/);
  });

  it("throws when .req.header is missing", () => {
    const c = validContext() as Record<string, unknown>;
    (c.req as Record<string, unknown>).header = "not a function";
    expect(() => toMwContext(c)).toThrow(/missing \.req\.header/);
  });

  it("throws when .header is missing", () => {
    const c = validContext() as Record<string, unknown>;
    delete c.header;
    expect(() => toMwContext(c)).toThrow(/missing \.header/);
  });

  it("throws when .json is missing", () => {
    const c = validContext() as Record<string, unknown>;
    delete c.json;
    expect(() => toMwContext(c)).toThrow(/missing \.json/);
  });

  it("error message includes the 'Ponder Context shape changed' anchor for grep-ability", () => {
    // Operators search release notes for this exact phrase when the indexer starts
    // throwing on every request after a dependency bump.
    const c = validContext() as Record<string, unknown>;
    delete c.req;
    expect(() => toMwContext(c)).toThrow(/Ponder Context shape changed/);
  });
});
