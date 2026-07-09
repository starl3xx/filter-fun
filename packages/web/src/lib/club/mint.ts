/// Mint-quantity clamp math for the /club mint page (Epic 2.6 / spec
/// §47.3.8).
///
/// Pure functions only — no React, no contract reads (same posture as
/// `lib/launch/economics.ts`): the page passes in the on-chain reads it has
/// on hand and gets back the stepper bounds. Tests hit this directly without
/// mounting a tree.
///
/// The contract enforces both caps independently (`SoldOut` on
/// `last + qty > maxSupply`, `WalletCapExceeded` on
/// `mintedBy + qty > walletMintCap`); this mirror keeps the stepper from
/// ever offering a quantity the chain would revert.

export type MintBounds = {
  /// Passes minted so far (`totalMinted()`).
  totalMinted: bigint;
  /// Collection cap (`maxSupply()`).
  maxSupply: bigint;
  /// Lifetime per-wallet cap (`walletMintCap()`).
  walletMintCap: bigint;
  /// Lifetime mints by the connected wallet (`mintedBy(address)`).
  mintedByWallet: bigint;
};

/// Maximum quantity the connected wallet can mint right now:
/// `min(walletMintCap − mintedBy, maxSupply − totalMinted)`, floored at 0.
export function maxMintable({totalMinted, maxSupply, walletMintCap, mintedByWallet}: MintBounds): bigint {
  const remainingSupply = maxSupply > totalMinted ? maxSupply - totalMinted : 0n;
  const remainingWallet = walletMintCap > mintedByWallet ? walletMintCap - mintedByWallet : 0n;
  return remainingSupply < remainingWallet ? remainingSupply : remainingWallet;
}

/// Clamp a requested stepper quantity into `[1, maxMintable]`. When nothing
/// is mintable (sold out / wallet capped), returns 0 — the caller disables
/// the mint button rather than rendering a lying "1".
export function clampMintQty(requested: bigint, bounds: MintBounds): bigint {
  const max = maxMintable(bounds);
  if (max === 0n) return 0n;
  if (requested < 1n) return 1n;
  return requested > max ? max : requested;
}
