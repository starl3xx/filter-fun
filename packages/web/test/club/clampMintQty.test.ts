/// Unit tests: mint-quantity clamp math (Epic 2.6 / spec §47.3.8).
///
/// The stepper's bounds mirror the contract's two independent caps —
/// `SoldOut` (supply) and `WalletCapExceeded` (per-wallet lifetime). The
/// pure helpers are the single source of the min() so the page can never
/// offer a quantity the chain would revert.

import {describe, expect, it} from "vitest";

import {clampMintQty, maxMintable, type MintBounds} from "@/lib/club/mint";

function bounds(overrides: Partial<MintBounds> = {}): MintBounds {
  return {
    totalMinted: 0n,
    maxSupply: 250n,
    walletMintCap: 2n,
    mintedByWallet: 0n,
    ...overrides,
  };
}

describe("maxMintable", () => {
  it("is bounded by the wallet cap when supply is plentiful", () => {
    expect(maxMintable(bounds())).toBe(2n);
  });

  it("is bounded by remaining supply when the collection is nearly out", () => {
    expect(maxMintable(bounds({totalMinted: 249n}))).toBe(1n);
  });

  it("subtracts prior wallet mints from the cap", () => {
    expect(maxMintable(bounds({mintedByWallet: 1n}))).toBe(1n);
  });

  it("is 0 when sold out", () => {
    expect(maxMintable(bounds({totalMinted: 250n}))).toBe(0n);
  });

  it("is 0 when the wallet already hit its lifetime cap", () => {
    expect(maxMintable(bounds({mintedByWallet: 2n}))).toBe(0n);
  });

  it("floors at 0 instead of underflowing when state exceeds caps", () => {
    // Defensive: totalMinted > maxSupply / mintedBy > cap can't happen
    // on-chain, but a mid-migration indexer or a stale read must not throw
    // a bigint underflow into the render path.
    expect(maxMintable(bounds({totalMinted: 251n}))).toBe(0n);
    expect(maxMintable(bounds({mintedByWallet: 3n}))).toBe(0n);
  });
});

describe("clampMintQty", () => {
  it("passes through an in-range quantity", () => {
    expect(clampMintQty(1n, bounds())).toBe(1n);
    expect(clampMintQty(2n, bounds())).toBe(2n);
  });

  it("clamps above the wallet-capped max", () => {
    expect(clampMintQty(5n, bounds())).toBe(2n);
  });

  it("clamps above the supply-capped max", () => {
    expect(clampMintQty(5n, bounds({totalMinted: 249n}))).toBe(1n);
  });

  it("floors a zero/negative request at 1 while mintable", () => {
    expect(clampMintQty(0n, bounds())).toBe(1n);
    expect(clampMintQty(-3n, bounds())).toBe(1n);
  });

  it("returns 0 when nothing is mintable (sold out / wallet capped)", () => {
    // 0 — not 1 — so the caller disables the button instead of rendering a
    // stepper that promises a mint the chain would revert.
    expect(clampMintQty(1n, bounds({totalMinted: 250n}))).toBe(0n);
    expect(clampMintQty(1n, bounds({mintedByWallet: 2n}))).toBe(0n);
  });
});
