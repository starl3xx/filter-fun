/// Tests for the operator allow-list parser — Epic 1.21 / spec §47.2.

import {describe, expect, it} from "vitest";

import {isOperator, parseOperatorAllowlist} from "@/lib/operator/config";

const A = "0x0Fc0F78fc939606db65F5BBF2F3715262C0b2F6E";
const B = "0x000000000000000000000000000000000000dEaD";

describe("parseOperatorAllowlist", () => {
  it("returns empty for unset / blank", () => {
    expect(parseOperatorAllowlist(undefined)).toEqual([]);
    expect(parseOperatorAllowlist("")).toEqual([]);
    expect(parseOperatorAllowlist(",, ,")).toEqual([]);
  });

  it("checksums the parsed addresses", () => {
    const lower = A.toLowerCase();
    const r = parseOperatorAllowlist(lower);
    expect(r[0]).toBe(A);
  });

  it("drops malformed addresses silently", () => {
    const r = parseOperatorAllowlist(`${A},not-an-address,0x1234`);
    expect(r).toHaveLength(1);
    expect(r[0]).toBe(A);
  });

  it("parses multiple comma-separated addresses with whitespace", () => {
    const r = parseOperatorAllowlist(` ${A} , ${B.toLowerCase()} `);
    expect(r).toHaveLength(2);
    expect(r).toContain(A);
    expect(r).toContain(B);
  });
});

describe("isOperator", () => {
  it("returns false for null/undefined/blank inputs", () => {
    expect(isOperator(null)).toBe(false);
    expect(isOperator(undefined)).toBe(false);
    expect(isOperator("")).toBe(false);
    expect(isOperator("0xnot-an-address")).toBe(false);
  });

  it("respects the build-time allow-list", () => {
    // The OPERATOR_ALLOWLIST is resolved at module load from
    // process.env.NEXT_PUBLIC_OPERATOR_WALLETS — empty in test env, so
    // every input is non-operator. Pinning that as the regression: the
    // module must NOT no-op-allow when the env is empty.
    expect(isOperator(A)).toBe(false);
    expect(isOperator(B)).toBe(false);
  });
});
