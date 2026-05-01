/// Unit tests for `validateLaunchFields` + metadata builder.
///
/// The contract stores the metadataURI as an opaque string by design
/// (spec §4.6 + ROADMAP note "field validation is off-chain"), so this
/// validation is the only enforcement layer between user input and a
/// permanent on-chain artifact. These tests are the contract on it.

import {describe, expect, it} from "vitest";

import {buildMetadataDoc, canonicalSymbol, validateLaunchFields, type LaunchFormFields} from "@/lib/launch/validation";

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
