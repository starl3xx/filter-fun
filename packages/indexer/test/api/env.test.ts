/// env helper tests — small, but worth pinning since the same parser sits behind every
/// CACHE_* / RATELIMIT_* knob and a silent regression here would be very confusing in
/// production logs.

import {describe, expect, it} from "vitest";

import {boolEnv, numEnv} from "../../src/api/env.js";

describe("numEnv", () => {
  it("returns default when env var is unset or empty", () => {
    expect(numEnv({}, "K", 42)).toBe(42);
    expect(numEnv({K: ""}, "K", 42)).toBe(42);
  });

  it("parses positive numbers", () => {
    expect(numEnv({K: "100"}, "K", 1)).toBe(100);
  });

  it("rejects non-positive, non-numeric, or NaN", () => {
    expect(() => numEnv({K: "0"}, "K", 1)).toThrow();
    expect(() => numEnv({K: "-5"}, "K", 1)).toThrow();
    expect(() => numEnv({K: "abc"}, "K", 1)).toThrow();
    expect(() => numEnv({K: "Infinity"}, "K", 1)).toThrow();
  });
});

describe("boolEnv", () => {
  it("returns default when unset or empty", () => {
    expect(boolEnv({}, "K", true)).toBe(true);
    expect(boolEnv({K: ""}, "K", false)).toBe(false);
  });

  it("accepts truthy aliases (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "True", "yes", "YES"]) {
      expect(boolEnv({K: v}, "K", false)).toBe(true);
    }
  });

  it("accepts falsy aliases (case-insensitive)", () => {
    for (const v of ["0", "false", "FALSE", "no", "NO"]) {
      expect(boolEnv({K: v}, "K", true)).toBe(false);
    }
  });

  it("rejects unrecognized values", () => {
    expect(() => boolEnv({K: "maybe"}, "K", false)).toThrow();
    expect(() => boolEnv({K: "2"}, "K", false)).toThrow();
  });
});
