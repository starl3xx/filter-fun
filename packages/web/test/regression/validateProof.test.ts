/// Audit H-Web-3 (Phase 1, 2026-05-01) regression — Merkle proof validator.
///
/// Pre-fix the rollover/bonus claim pages only checked `Array.isArray` +
/// every-item is-string. Pin the parameterised cases here so a regression that
/// drops one of the bounds checks (length cap, hex format, length-of-hex)
/// surfaces in CI.
import {describe, expect, it} from "vitest";

import {MAX_PROOF_LENGTH, validateProof} from "../../src/lib/claim/validateProof.js";

describe("validateProof spec lock (Audit H-Web-3)", () => {
  it("rejects non-array input", () => {
    expect(() => validateProof("not-an-array")).toThrow(/must be an array/);
    expect(() => validateProof(null)).toThrow(/must be an array/);
    expect(() => validateProof(undefined)).toThrow(/must be an array/);
    expect(() => validateProof({0: "0x" + "a".repeat(64)})).toThrow(/must be an array/);
  });

  it("rejects empty array (catch-the-mass-mistake before contract revert)", () => {
    expect(() => validateProof([])).toThrow(/cannot be empty/);
  });

  it(`rejects arrays longer than MAX_PROOF_LENGTH (${MAX_PROOF_LENGTH})`, () => {
    const tooLong = Array.from({length: MAX_PROOF_LENGTH + 1}, () => "0x" + "a".repeat(64));
    expect(() => validateProof(tooLong)).toThrow(/proof too long/);
  });

  it("rejects array containing a non-hex string", () => {
    const bad = ["0x" + "a".repeat(64), "not-hex", "0x" + "b".repeat(64)];
    expect(() => validateProof(bad)).toThrow(/proof\[1\]/);
  });

  it("rejects array containing a wrong-length hex string", () => {
    const tooShort = ["0x" + "a".repeat(63)];
    const tooLong = ["0x" + "a".repeat(65)];
    expect(() => validateProof(tooShort)).toThrow(/proof\[0\]/);
    expect(() => validateProof(tooLong)).toThrow(/proof\[0\]/);
  });

  it("rejects array containing a non-0x-prefixed hex string", () => {
    const bare = ["a".repeat(64)];
    expect(() => validateProof(bare)).toThrow(/proof\[0\]/);
  });

  it("accepts a valid 1-element proof (smallest case)", () => {
    expect(() => validateProof(["0x" + "a".repeat(64)])).not.toThrow();
  });

  it(`accepts a valid ${MAX_PROOF_LENGTH}-element proof (largest valid case)`, () => {
    const proof = Array.from({length: MAX_PROOF_LENGTH}, (_, i) =>
      "0x" + i.toString(16).padStart(64, "0"),
    );
    expect(() => validateProof(proof)).not.toThrow();
  });

  it("accepts mixed-case hex (Solidity bytes32 ABI-encoded values are unambiguous)", () => {
    const mixed = ["0x" + "AbCdEf12".repeat(8)];
    expect(() => validateProof(mixed)).not.toThrow();
  });
});
