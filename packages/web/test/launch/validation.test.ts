/// Unit tests for `validateLaunchFields` + metadata builder.
///
/// The contract stores the metadataURI as an opaque string by design
/// (spec §4.6 + ROADMAP note "field validation is off-chain"), so this
/// validation is the only enforcement layer between user input and a
/// permanent on-chain artifact. These tests are the contract on it.

import {describe, expect, it} from "vitest";

import {
  buildMetadataDoc,
  canonicalSymbol,
  coerceLaunchFields,
  validateLaunchFields,
  type LaunchFormFields,
} from "@/lib/launch/validation";

const valid: LaunchFormFields = {
  name: "Filtermaxx",
  ticker: "MAXX",
  description: "A token built to survive the filter and fund the winner.",
  imageUrl: "https://cdn.example.com/logo.png",
  website: "https://maxx.example",
  twitter: "filtermaxx",
  farcaster: "filtermaxx",
};

describe("validateLaunchFields", () => {
  it("accepts a fully valid payload", () => {
    expect(validateLaunchFields(valid)).toEqual({});
  });

  it("rejects too-short name + ticker", () => {
    const errs = validateLaunchFields({...valid, name: "A", ticker: "M"});
    expect(errs.name).toMatch(/at least 2/);
    expect(errs.ticker).toMatch(/2–10 chars/);
  });

  it("rejects ticker with lowercase / special characters", () => {
    const errs = validateLaunchFields({...valid, ticker: "max!"});
    expect(errs.ticker).toBeDefined();
  });

  it("rejects too-short and too-long descriptions", () => {
    expect(validateLaunchFields({...valid, description: "short"}).description).toMatch(/at least 16/);
    expect(validateLaunchFields({...valid, description: "x".repeat(281)}).description).toMatch(/max 280/);
  });

  it("rejects non-https image URL", () => {
    expect(validateLaunchFields({...valid, imageUrl: "http://x.com/y.png"}).imageUrl).toBeDefined();
    expect(validateLaunchFields({...valid, imageUrl: "ftp://x"}).imageUrl).toBeDefined();
  });

  it("rejects @ prefix on social handles", () => {
    expect(validateLaunchFields({...valid, twitter: "@x"}).twitter).toBeDefined();
    expect(validateLaunchFields({...valid, farcaster: "@x"}).farcaster).toBeDefined();
  });

  it("treats empty optional fields as valid", () => {
    expect(validateLaunchFields({...valid, website: "", twitter: "", farcaster: ""})).toEqual({});
  });
});

describe("canonicalSymbol", () => {
  it("uppercases and trims", () => {
    expect(canonicalSymbol(" maxx ")).toBe("MAXX");
  });
});

describe("buildMetadataDoc", () => {
  it("normalizes social handles to URLs", () => {
    const doc = buildMetadataDoc(valid);
    expect(doc.symbol).toBe("MAXX");
    expect((doc.links as Record<string, string>).twitter).toBe("https://twitter.com/filtermaxx");
    expect((doc.links as Record<string, string>).farcaster).toBe("https://warpcast.com/filtermaxx");
  });

  it("omits links when no socials provided", () => {
    const doc = buildMetadataDoc({...valid, website: "", twitter: "", farcaster: ""});
    expect(doc.links).toBeUndefined();
  });
});

describe("coerceLaunchFields (hostile-client guard)", () => {
  it("turns null / non-object input into all-empty fields", () => {
    expect(coerceLaunchFields(null)).toEqual({name: "", ticker: "", description: "", imageUrl: ""});
    expect(coerceLaunchFields("oops")).toEqual({name: "", ticker: "", description: "", imageUrl: ""});
    expect(coerceLaunchFields(42)).toEqual({name: "", ticker: "", description: "", imageUrl: ""});
  });

  it("substitutes empty strings for non-string fields (no TypeError)", () => {
    const out = coerceLaunchFields({name: 42, ticker: null, description: {}, imageUrl: []});
    expect(out.name).toBe("");
    expect(out.ticker).toBe("");
    expect(out.description).toBe("");
    expect(out.imageUrl).toBe("");
  });

  it("preserves valid string fields", () => {
    const out = coerceLaunchFields(valid);
    expect(out).toMatchObject(valid);
  });

  it("keeps optional fields only when they are strings", () => {
    const out = coerceLaunchFields({...valid, twitter: 123, farcaster: null});
    // `twitter` from `valid` is a string but the override forced 123 → drop.
    // Optional strings must survive even when other fields are coerced.
    expect(out.twitter).toBeUndefined();
    expect(out.farcaster).toBeUndefined();
    expect(out.website).toBe(valid.website);
  });

  it("composes with validateLaunchFields to surface shape problems as field errors", () => {
    // Hostile payload: empty object → coerce → validate → 4 required-field errors,
    // not a TypeError.
    const fields = coerceLaunchFields({});
    const errs = validateLaunchFields(fields);
    expect(errs.name).toBeDefined();
    expect(errs.ticker).toBeDefined();
    expect(errs.description).toBeDefined();
    expect(errs.imageUrl).toBeDefined();
  });
});
