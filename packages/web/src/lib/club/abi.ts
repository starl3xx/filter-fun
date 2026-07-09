/// FilterClubPass ABI fragment — Epic 2.6 / spec §47.3.8.
///
/// Hand-written viem-style const, mirroring the slice the web needs (same
/// posture as `lib/launch/abi.ts`): the /club mint page reads supply / price
/// / caps and writes `mint(qty)`; the launch flow reads `creditsRemaining`
/// for the free-launch credit toggle. Full ABI lives in
/// `packages/contracts/out/FilterClubPass.sol/FilterClubPass.json` and the
/// indexer (`packages/indexer/src/FilterClubPass.ts`). The contract test
/// suite is the drift guard on both sides.
///
/// Credit semantics worth restating at the ABI boundary: credits are keyed to
/// the TOKEN (`creditsOf(tokenId)`), not the wallet — they travel with the
/// pass on transfer. `creditsRemaining(address)` is the display-only sum
/// across every pass the wallet currently owns; the launcher never calls it.

export const FilterClubPassAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    inputs: [{name: "qty", type: "uint256"}],
    outputs: [],
  },
  {
    type: "function",
    name: "totalMinted",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "maxSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "mintPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "walletMintCap",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint32"}],
  },
  {
    type: "function",
    name: "mintedBy",
    stateMutability: "view",
    inputs: [{name: "wallet", type: "address"}],
    outputs: [{type: "uint32"}],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "bool"}],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{name: "owner", type: "address"}],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "tokenOfOwnerByIndex",
    stateMutability: "view",
    inputs: [
      {name: "owner", type: "address"},
      {name: "index", type: "uint256"},
    ],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "creditsOf",
    stateMutability: "view",
    inputs: [{name: "tokenId", type: "uint256"}],
    outputs: [{type: "uint8"}],
  },
  {
    type: "function",
    name: "armedTokenOf",
    stateMutability: "view",
    inputs: [{name: "holder", type: "address"}],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "creditsRemaining",
    stateMutability: "view",
    inputs: [{name: "holder", type: "address"}],
    outputs: [{type: "uint256"}],
  },
  // ---- mint() revert surface (one custom error per gate) ----
  {type: "error", name: "SoldOut", inputs: []},
  {type: "error", name: "WrongPayment", inputs: []},
  {type: "error", name: "InvalidQuantity", inputs: []},
  {type: "error", name: "WalletCapExceeded", inputs: []},
  {type: "error", name: "PayoutFailed", inputs: []},
  {
    type: "event",
    name: "Minted",
    inputs: [
      {name: "to", type: "address", indexed: true},
      {name: "tokenId", type: "uint256", indexed: true},
      {name: "pricePaid", type: "uint256", indexed: false},
    ],
  },
] as const;
