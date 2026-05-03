/// Audit H-1 (Phase 1, 2026-05-01) regression — TokenRow placeholder honesty.
///
/// Pre-fix the placeholder fields (`price`/`priceChange24h`/`volume24h`/`liquidity`/
/// `holders`) all returned literal `0`/`"0"`, conflating "value is genuinely zero"
/// with "indexer hasn't wired this read yet." Frontend rendered "0 holders / $0
/// liquidity" for every token across genesis.
///
/// Post-fix: each pending field returns `null` (web renders "—") and the response
/// carries a `dataAvailability` block so the renderer can gate cell display
/// cohort-wide. When V4 reads land or `/tokens/:address/holders` ships, the
/// `TOKEN_DATA_AVAILABILITY` constant flips and the same response shape carries
/// real values.
import {describe, expect, it} from "vitest";

import {
  buildTokensResponse,
  TOKEN_DATA_AVAILABILITY,
  type TokenRow,
} from "../../../src/api/builders.js";

function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

const baseRow: TokenRow = {
  id: addr(1),
  symbol: "TKN",
  isFinalist: false,
  liquidated: false,
  liquidationProceeds: null,
  // Audit M-Indexer-1: creator is required on TokenRow now.
  creator: "0x000000000000000000000000000000000000beef",
};

describe("TokenRow placeholder honesty (Audit H-1)", () => {
  it("placeholder path returns null for each V4-pending field", () => {
    const out = buildTokensResponse([baseRow], new Map(), "competition", new Map(), 0n);
    expect(out).toHaveLength(1);
    const row = out[0]!;
    // All four V4-driven fields must be null while the integration is pending.
    expect(row.price).toBeNull();
    expect(row.priceChange24h).toBeNull();
    expect(row.volume24h).toBeNull();
    expect(row.liquidity).toBeNull();
  });

  it("placeholder path returns null for holders while enumeration endpoint is deferred", () => {
    const out = buildTokensResponse([baseRow], new Map(), "competition", new Map(), 0n);
    expect(out[0]!.holders).toBeNull();
  });

  it("dataAvailability block carries the per-row availability signal", () => {
    const out = buildTokensResponse([baseRow], new Map(), "competition", new Map(), 0n);
    expect(out[0]!.dataAvailability).toEqual({
      v4Reads: false,
      holderEnumeration: false,
    });
  });

  it("TOKEN_DATA_AVAILABILITY is the single source of truth for the placeholder gates", () => {
    // The constant lives in builders.ts. If a future change wires real V4 reads, the
    // flip should happen here AND the corresponding fields populate from the real source
    // — leaving the constant on `false` while populating the fields would be a regression.
    expect(TOKEN_DATA_AVAILABILITY.v4Reads).toBe(false);
    expect(TOKEN_DATA_AVAILABILITY.holderEnumeration).toBe(false);
  });

  it("non-placeholder fields (rank, hp, status, components, bagLock) still populate", () => {
    // Pinned so a regression that flipped EVERYTHING to null lights up here too.
    const out = buildTokensResponse([baseRow], new Map(), "competition", new Map(), 0n);
    const row = out[0]!;
    expect(typeof row.rank).toBe("number");
    expect(typeof row.hp).toBe("number");
    expect(row.status).toBeDefined();
    expect(row.components).toBeDefined();
    expect(row.bagLock).toBeDefined();
  });
});
