/// Formatting helpers — fmtEthShort and addrEq are used in load-bearing UI
/// branches (claim button copy, auth-state matching). Misformat or wrong
/// equality and the wrong button surfaces.

import {describe, expect, it} from "vitest";

import {addrEq, fmtEthShort, isZeroAddress, shortAddr} from "@/lib/token/format";

describe("fmtEthShort", () => {
  it("zero → 'Ξ0'", () => {
    expect(fmtEthShort(0n)).toBe("Ξ0");
  });

  it("1 ETH → 'Ξ1'", () => {
    expect(fmtEthShort(1_000_000_000_000_000_000n)).toBe("Ξ1");
  });

  it("0.34 ETH → 'Ξ0.34'", () => {
    expect(fmtEthShort(340_000_000_000_000_000n)).toBe("Ξ0.34");
  });

  it("0.084 ETH → 'Ξ0.084'", () => {
    expect(fmtEthShort(84_000_000_000_000_000n)).toBe("Ξ0.084");
  });

  it("dust below 0.0001 ETH → '<Ξ0.0001'", () => {
    expect(fmtEthShort(1n)).toBe("<Ξ0.0001");
    expect(fmtEthShort(50_000_000_000n)).toBe("<Ξ0.0001"); // 5e-8 ETH
  });
});

describe("addrEq", () => {
  it("matches across casings", () => {
    expect(
      addrEq("0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ).toBe(true);
  });

  it("rejects mismatches", () => {
    expect(
      addrEq("0xaaaa", "0xbbbb"),
    ).toBe(false);
  });

  it("nullish operands → false (no false-positive equality)", () => {
    expect(addrEq(null, "0x1")).toBe(false);
    expect(addrEq("0x1", null)).toBe(false);
    expect(addrEq(null, null)).toBe(false);
  });
});

describe("isZeroAddress", () => {
  it("zero addr → true", () => {
    expect(isZeroAddress("0x0000000000000000000000000000000000000000")).toBe(true);
  });
  it("any other addr → false", () => {
    expect(isZeroAddress("0x1234567890123456789012345678901234567890")).toBe(false);
  });
  it("null/empty → true (treats as zero for guard purposes)", () => {
    expect(isZeroAddress(null)).toBe(true);
    expect(isZeroAddress(undefined)).toBe(true);
  });
});

describe("shortAddr", () => {
  it("0x… → 0xaaaa…aaaa form", () => {
    expect(shortAddr("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe("0xaaaa…aaaa");
  });
});
