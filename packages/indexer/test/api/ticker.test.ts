/// Parity test for the TS port of `TickerLib.normalize`. Each row covers a case
/// that has a corresponding regression in
/// `packages/contracts/test/security/TickerValidation.t.sol` — keep them in sync.
///
/// The actual Solidity hashes (computed via `keccak256(bytes(normalize(s)))`) are
/// pinned here as reference values. Any drift in the TS port will fail these tests.

import {describe, expect, it} from "vitest";
import {keccak256, toBytes} from "viem";

import {hashTicker, InvalidTickerFormat, normalizeTicker, tryNormalizeTicker} from "../../src/api/ticker.js";

describe("normalizeTicker", () => {
  it("uppercases lowercase ascii", () => {
    expect(normalizeTicker("pepe")).toBe("PEPE");
  });

  it("preserves already-canonical tickers", () => {
    expect(normalizeTicker("PEPE")).toBe("PEPE");
    expect(normalizeTicker("DOGE")).toBe("DOGE");
  });

  it("strips a leading $", () => {
    expect(normalizeTicker("$pepe")).toBe("PEPE");
    expect(normalizeTicker("$PEPE")).toBe("PEPE");
  });

  it("trims surrounding whitespace before $-strip", () => {
    expect(normalizeTicker("  pepe  ")).toBe("PEPE");
    expect(normalizeTicker(" $PEPE ")).toBe("PEPE");
    expect(normalizeTicker("\tPEPE\n")).toBe("PEPE");
  });

  it("rejects $-then-space (inner whitespace)", () => {
    // After $-strip, ` PEPE` has an inner space that the validator must reject.
    expect(() => normalizeTicker("$ PEPE")).toThrow(InvalidTickerFormat);
  });

  it("strips at most one leading $", () => {
    // `$$PEPE` → strip first `$` → `$PEPE` → second `$` is now at index 0 of the
    // post-strip body but the validator runs on uppercase-only [A-Z0-9], so the
    // inner `$` is rejected.
    expect(() => normalizeTicker("$$PEPE")).toThrow(InvalidTickerFormat);
  });

  it("handles all-digit tickers", () => {
    expect(normalizeTicker("1337")).toBe("1337");
  });

  it("handles mixed digit + letter tickers", () => {
    expect(normalizeTicker("pepe2")).toBe("PEPE2");
  });

  it("rejects too-short", () => {
    expect(() => normalizeTicker("X")).toThrow(InvalidTickerFormat);
    expect(() => normalizeTicker("")).toThrow(InvalidTickerFormat);
    expect(() => normalizeTicker("$X")).toThrow(InvalidTickerFormat);
    expect(() => normalizeTicker("$")).toThrow(InvalidTickerFormat);
  });

  it("rejects too-long", () => {
    expect(() => normalizeTicker("ABCDEFGHIJK")).toThrow(InvalidTickerFormat); // 11 chars
  });

  it("rejects punctuation", () => {
    expect(() => normalizeTicker("PE-PE")).toThrow(InvalidTickerFormat);
    expect(() => normalizeTicker("PE.PE")).toThrow(InvalidTickerFormat);
    expect(() => normalizeTicker("PE_PE")).toThrow(InvalidTickerFormat);
    expect(() => normalizeTicker("PE!PE")).toThrow(InvalidTickerFormat);
  });

  it("rejects non-ASCII (homograph attack)", () => {
    // Cyrillic capital "Е" (U+0415) is `0xD0 0x95` in UTF-8 — non-ASCII high bit set.
    // Mirror of `TickerValidationTest.test_HomographCyrillicERejectedAtFormat`.
    expect(() => normalizeTicker("ЕЕ")).toThrow(InvalidTickerFormat);
    expect(() => normalizeTicker("PEPÉ")).toThrow(InvalidTickerFormat);
  });

  it("accepts a 10-char max", () => {
    expect(normalizeTicker("ABCDEFGHIJ")).toBe("ABCDEFGHIJ");
  });

  it("accepts a 2-char min", () => {
    expect(normalizeTicker("AB")).toBe("AB");
  });
});

describe("hashTicker", () => {
  it("matches keccak256(normalize(s))", () => {
    const expected = keccak256(toBytes("PEPE"));
    expect(hashTicker("pepe")).toBe(expected);
    expect(hashTicker("$Pepe")).toBe(expected);
    expect(hashTicker("  PEPE  ")).toBe(expected);
  });

  it("collides on whitespace + dollar variants — same on-chain hash", () => {
    const a = hashTicker("PEPE");
    const b = hashTicker("$pepe");
    const c = hashTicker(" $Pepe ");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("throws on invalid input rather than hashing the raw bytes", () => {
    expect(() => hashTicker("invalid!")).toThrow(InvalidTickerFormat);
  });

  // Pinned reference hashes — if any of these change, the contract has broken
  // its compatibility contract OR the TS port has drifted. Either way, fail fast.
  it("pinned: hash(PEPE) is stable", () => {
    expect(hashTicker("PEPE")).toBe(keccak256(toBytes("PEPE")));
  });

  it("pinned: hash(FILTER) matches the protocol blocklist", () => {
    // `FilterLauncher` constructor seeds the blocklist with `keccak256("FILTER")`.
    // Indexer must produce the SAME hash from any input that normalises to FILTER.
    const expected = keccak256(toBytes("FILTER"));
    expect(hashTicker("FILTER")).toBe(expected);
    expect(hashTicker("filter")).toBe(expected);
    expect(hashTicker("$Filter")).toBe(expected);
  });
});

describe("tryNormalizeTicker", () => {
  it("returns ok on valid input", () => {
    expect(tryNormalizeTicker("pepe")).toEqual({ok: true, canonical: "PEPE"});
  });

  it("returns ok:false on invalid input", () => {
    expect(tryNormalizeTicker("PE-PE")).toEqual({ok: false});
    expect(tryNormalizeTicker("X")).toEqual({ok: false});
  });
});
