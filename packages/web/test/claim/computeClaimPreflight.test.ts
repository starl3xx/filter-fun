/// Audit C-6 (Phase 1 audit 2026-05-01) regression test — pure preflight
/// decision for the claim CTA. Pre-fix the claim button issued
/// `writeContract` without ANY check; this suite locks the policy:
///
///   1. wrong chain → wrong-chain (regardless of balance)
///   2. correct chain + zero balance → no-balance
///   3. correct chain + null balance (read not resolved) → no-balance
///      (we MUST NOT default to "ok" while balance is loading — the whole
///      point of the guard is preventing sign-then-fail flows)
///   4. correct chain + positive balance → ok
///
/// Each `expect(result).toEqual({ok: false, reason: …})` is paired with a
/// message-shape assertion so a copy-only edit doesn't mask a behavioural
/// regression in the reason discriminant.
import {describe, expect, it} from "vitest";

import {computeClaimPreflight} from "@/components/ClaimForm";

const BASE_SEPOLIA = {id: 84532, name: "Base Sepolia", nativeCurrencySymbol: "ETH"} as const;
const BASE_MAINNET = {id: 8453, name: "Base"} as const;

describe("computeClaimPreflight (audit finding C-6)", () => {
  it("wrong chain reports `wrong-chain` and names BOTH the connected chain and the expected one", () => {
    const r = computeClaimPreflight({
      walletChain: BASE_MAINNET,
      expectedChain: BASE_SEPOLIA,
      balanceWei: 1_000_000_000_000_000_000n, // 1 ETH on the wrong chain — still fails
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("wrong-chain");
    expect(r.message).toContain("Base"); // wallet is on Base
    expect(r.message).toContain("Base Sepolia"); // expected chain
  });

  it("walletChain=null is treated as wrong chain (covers the disconnected/loading case)", () => {
    const r = computeClaimPreflight({
      walletChain: null,
      expectedChain: BASE_SEPOLIA,
      balanceWei: 1n,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("wrong-chain");
    expect(r.message).toContain("unknown"); // fallback chain label
  });

  it("correct chain + zero balance → no-balance with the chain's native currency in the message", () => {
    const r = computeClaimPreflight({
      walletChain: BASE_SEPOLIA,
      expectedChain: BASE_SEPOLIA,
      balanceWei: 0n,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no-balance");
    expect(r.message).toContain("ETH");
    expect(r.message).toContain("Base Sepolia");
  });

  it("correct chain + null balance (read not resolved) → no-balance, NOT ok", () => {
    // Load-bearing: the pre-fix bug let claim through whenever a check was
    // unresolved. This test pins "loading == fail closed" so a future
    // refactor can't silently flip the default to permissive.
    const r = computeClaimPreflight({
      walletChain: BASE_SEPOLIA,
      expectedChain: BASE_SEPOLIA,
      balanceWei: null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no-balance");
  });

  it("correct chain + positive balance → ok", () => {
    const r = computeClaimPreflight({
      walletChain: BASE_SEPOLIA,
      expectedChain: BASE_SEPOLIA,
      balanceWei: 1n, // even 1 wei flips this to ok — gas-sufficiency is wallet-side
    });
    expect(r.ok).toBe(true);
  });

  it("chain check fires BEFORE balance check (order is load-bearing)", () => {
    // Wrong chain AND zero balance — must report wrong-chain (the actionable
    // fix) rather than no-balance (which would trick the user into topping up
    // a wallet on the wrong chain).
    const r = computeClaimPreflight({
      walletChain: BASE_MAINNET,
      expectedChain: BASE_SEPOLIA,
      balanceWei: 0n,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("wrong-chain");
  });
});
