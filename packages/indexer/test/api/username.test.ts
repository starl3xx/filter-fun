/// Pure-module tests for username domain logic. No DB, no signing — just the
/// rules the rest of the surface composes against.

import {describe, expect, it} from "vitest";

import {
  buildSetUsernameMessage,
  classifyIdentifier,
  evaluateSetUsername,
  isReserved,
  isWithinCooldown,
  RESERVED_USERNAMES,
  USERNAME_COOLDOWN_MS,
  validateUsernameFormat,
} from "../../src/api/username.js";

describe("validateUsernameFormat", () => {
  it("accepts the simplest valid handle", () => {
    const r = validateUsernameFormat("abc");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonical).toBe("abc");
      expect(r.display).toBe("abc");
    }
  });

  it("preserves user casing in display, lowercases canonical", () => {
    const r = validateUsernameFormat("StarBreaker");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonical).toBe("starbreaker");
      expect(r.display).toBe("StarBreaker");
    }
  });

  it("accepts dashes anywhere except as the only character", () => {
    expect(validateUsernameFormat("foo-bar").ok).toBe(true);
    expect(validateUsernameFormat("foo--bar").ok).toBe(true);
    expect(validateUsernameFormat("---").ok).toBe(true); // 3 chars, all valid
  });

  it("accepts digits and ASCII letters", () => {
    expect(validateUsernameFormat("user123").ok).toBe(true);
    expect(validateUsernameFormat("123abc").ok).toBe(true);
  });

  it("rejects empty / whitespace-only", () => {
    expect(validateUsernameFormat("")).toEqual({ok: false, error: "empty"});
  });

  it("rejects below min length", () => {
    expect(validateUsernameFormat("ab")).toEqual({ok: false, error: "too-short"});
    expect(validateUsernameFormat("a")).toEqual({ok: false, error: "too-short"});
  });

  it("rejects above max length", () => {
    const tooLong = "a".repeat(33);
    expect(validateUsernameFormat(tooLong)).toEqual({ok: false, error: "too-long"});
  });

  it("accepts exactly 32 chars (boundary)", () => {
    const at32 = "a".repeat(32);
    expect(validateUsernameFormat(at32).ok).toBe(true);
  });

  it("rejects spaces", () => {
    expect(validateUsernameFormat("foo bar")).toEqual({ok: false, error: "invalid-chars"});
  });

  it("rejects underscores (per spec §38 dispatch)", () => {
    expect(validateUsernameFormat("foo_bar")).toEqual({ok: false, error: "invalid-chars"});
  });

  it("rejects punctuation, symbols, unicode", () => {
    expect(validateUsernameFormat("foo!bar")).toEqual({ok: false, error: "invalid-chars"});
    expect(validateUsernameFormat("foo.bar")).toEqual({ok: false, error: "invalid-chars"});
    expect(validateUsernameFormat("emoji😀")).toEqual({ok: false, error: "invalid-chars"});
    expect(validateUsernameFormat("ünicode")).toEqual({ok: false, error: "invalid-chars"});
  });
});

describe("isReserved", () => {
  it("blocks the baseline reserved set, case-insensitive", () => {
    expect(isReserved("filter")).toBe(true);
    expect(isReserved("FILTER")).toBe(true);
    expect(isReserved("Filter")).toBe(true);
    expect(isReserved("admin")).toBe(true);
    expect(isReserved("starl3xx")).toBe(true);
  });

  it("does not block close-but-not-equal handles", () => {
    expect(isReserved("filterz")).toBe(false);
    expect(isReserved("admins")).toBe(false);
    expect(isReserved("filter-fun")).toBe(false);
  });

  it("baseline list contains the spec-listed entries", () => {
    // Sanity guard: make sure a future drop-by-accident doesn't slip through.
    for (const w of [
      "filter",
      "fun",
      "official",
      "admin",
      "root",
      "system",
      "protocol",
      "creator",
      "holder",
      "winner",
      "champion",
      "genesis",
      "bankr",
      "starl3xx",
    ]) {
      expect(RESERVED_USERNAMES.has(w)).toBe(true);
    }
  });
});

describe("isWithinCooldown", () => {
  const NOW = new Date("2026-05-04T12:00:00.000Z");
  const FIFTEEN_DAYS_AGO = new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000);
  const THIRTY_ONE_DAYS_AGO = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000);

  it("returns false when no previous update", () => {
    expect(isWithinCooldown(null, NOW)).toBe(false);
  });

  it("returns true within the 30-day window", () => {
    expect(isWithinCooldown(FIFTEEN_DAYS_AGO, NOW)).toBe(true);
  });

  it("returns false past the 30-day window", () => {
    expect(isWithinCooldown(THIRTY_ONE_DAYS_AGO, NOW)).toBe(false);
  });

  it("respects custom cooldown ms", () => {
    const oneHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000);
    expect(isWithinCooldown(oneHourAgo, NOW, 30 * 60 * 1000)).toBe(false);
    expect(isWithinCooldown(oneHourAgo, NOW, 2 * 60 * 60 * 1000)).toBe(true);
  });

  it("USERNAME_COOLDOWN_MS is exactly 30 days", () => {
    expect(USERNAME_COOLDOWN_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe("buildSetUsernameMessage", () => {
  const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01" as `0x${string}`;

  it("formats with all fields lowercased", () => {
    const m = buildSetUsernameMessage(ADDR, "StarBreaker", "n123");
    expect(m).toBe(
      `filter.fun:set-username:0xabcdef0123456789abcdef0123456789abcdef01:starbreaker:n123`,
    );
  });

  it("normalizes mixed-case address before interpolation", () => {
    const upper = ADDR.toUpperCase().replace("0X", "0x") as `0x${string}`;
    const m = buildSetUsernameMessage(upper, "abc", "n");
    expect(m).toBe(
      `filter.fun:set-username:0xabcdef0123456789abcdef0123456789abcdef01:abc:n`,
    );
  });

  it("nonce is interpolated verbatim (caller controls opacity)", () => {
    const m = buildSetUsernameMessage(ADDR, "abc", "complex-nonce-value-42");
    expect(m.endsWith(":complex-nonce-value-42")).toBe(true);
  });
});

describe("evaluateSetUsername", () => {
  const NOW = new Date("2026-05-04T12:00:00.000Z");
  const ZERO_OPERATOR = {operatorBlocked: false};
  const ZERO_UNIQUENESS = {takenByOther: false};
  const ZERO_COOLDOWN = {lastUpdatedAt: null};

  it("returns canonical+display on success", () => {
    const r = evaluateSetUsername(
      "StarBreaker",
      ZERO_COOLDOWN,
      ZERO_UNIQUENESS,
      ZERO_OPERATOR,
      NOW,
    );
    expect(r).toEqual({ok: true, canonical: "starbreaker", display: "StarBreaker"});
  });

  it("rejects format errors first", () => {
    const r = evaluateSetUsername("ab", ZERO_COOLDOWN, ZERO_UNIQUENESS, ZERO_OPERATOR, NOW);
    expect(r).toEqual({error: "invalid-format", detail: "too-short"});
  });

  it("rejects baseline reserved word", () => {
    const r = evaluateSetUsername(
      "admin",
      ZERO_COOLDOWN,
      ZERO_UNIQUENESS,
      ZERO_OPERATOR,
      NOW,
    );
    expect(r).toEqual({error: "blocklisted"});
  });

  it("rejects operator-blocked even when not in baseline", () => {
    const r = evaluateSetUsername(
      "totally-fine",
      ZERO_COOLDOWN,
      ZERO_UNIQUENESS,
      {operatorBlocked: true},
      NOW,
    );
    expect(r).toEqual({error: "blocklisted"});
  });

  it("rejects taken-by-other", () => {
    const r = evaluateSetUsername(
      "starbreaker",
      ZERO_COOLDOWN,
      {takenByOther: true},
      ZERO_OPERATOR,
      NOW,
    );
    expect(r).toEqual({error: "taken"});
  });

  it("rejects active cooldown", () => {
    const fifteenDaysAgo = new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000);
    const r = evaluateSetUsername(
      "newhandle",
      {lastUpdatedAt: fifteenDaysAgo},
      ZERO_UNIQUENESS,
      ZERO_OPERATOR,
      NOW,
    );
    expect("error" in r && r.error === "cooldown-active").toBe(true);
    if ("error" in r && r.error === "cooldown-active") {
      // Cooldown ends at lastUpdated + 30d
      expect(r.nextEligibleAt.getTime()).toBe(
        fifteenDaysAgo.getTime() + USERNAME_COOLDOWN_MS,
      );
    }
  });

  it("rejection priority: format > blocklist > taken > cooldown", () => {
    // A request that violates EVERY rule should report the *first* in the
    // chain — format. This is the documented order.
    const r = evaluateSetUsername(
      "ab", // too-short — also reserved-word collision possibility ruled out
      {lastUpdatedAt: new Date(NOW.getTime() - 1000)}, // active cooldown
      {takenByOther: true},
      {operatorBlocked: true},
      NOW,
    );
    expect("error" in r && r.error === "invalid-format").toBe(true);
  });
});

describe("classifyIdentifier", () => {
  it("classifies lowercased address as address", () => {
    const a = "0xabcdef0123456789abcdef0123456789abcdef01";
    expect(classifyIdentifier(a)).toEqual({kind: "address", address: a});
  });

  it("classifies mixed-case address as address (lowercased)", () => {
    const a = "0xABCDEF0123456789abcdef0123456789ABCDEF01";
    expect(classifyIdentifier(a)).toEqual({
      kind: "address",
      address: a.toLowerCase(),
    });
  });

  it("classifies a valid handle as username (canonical)", () => {
    expect(classifyIdentifier("StarBreaker")).toEqual({
      kind: "username",
      username: "starbreaker",
    });
  });

  it("rejects invalid (too-short) as invalid", () => {
    expect(classifyIdentifier("ab")).toEqual({kind: "invalid"});
  });

  it("a 0x-prefixed shorter-than-40 string falls through as a username", () => {
    // 0x-prefixed but only 8 chars — fails the address regex (needs exactly
    // 40 hex), but `0xnothex` is alphanumeric so it routes to the username
    // path. The username path will then 404 if it doesn't exist.
    expect(classifyIdentifier("0xnothex")).toEqual({
      kind: "username",
      username: "0xnothex",
    });
  });

  it("rejects illegal-char identifier as invalid", () => {
    // Has dot — fails both the address regex AND the username charset, so
    // routes to invalid.
    expect(classifyIdentifier("foo.bar")).toEqual({kind: "invalid"});
  });

  it("rejects whitespace as invalid", () => {
    expect(classifyIdentifier("foo bar")).toEqual({kind: "invalid"});
  });
});
