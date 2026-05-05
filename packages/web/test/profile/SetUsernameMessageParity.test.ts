/// Parity guard for the `set-username` signed-message format — Epic 1.24
/// (bugbot M PR #102 pass-5).
///
/// `buildSetUsernameMessage` is independently defined in both packages
/// because they don't share a workspace dep, but the two copies MUST agree
/// byte-for-byte: the wallet client signs the web copy, the indexer recovers
/// against the indexer copy, and any drift makes every set-username POST
/// fail with 401 for all users.
///
/// This test pins the canonical output to a hard-coded literal. The indexer
/// has the symmetric pin at `packages/indexer/test/api/username.test.ts`
/// ("formats with all fields lowercased"). If either side changes, that
/// side's literal-pin test fails immediately — the security boundary
/// surfaces as a build failure, not a silent runtime regression.

import {describe, expect, it} from "vitest";

import {buildSetUsernameMessage} from "@/lib/arena/api";

describe("buildSetUsernameMessage (web side) — parity with indexer", () => {
  const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01" as `0x${string}`;

  it("formats with all fields lowercased — same literal as indexer test", () => {
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
