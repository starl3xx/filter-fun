/// Minimal `BonusDistributor` ABI fragment used by the bonus driver. Same rationale as
/// `SeasonVaultAbi` and `FilterLauncherAbi`: inline so the package stays self-contained,
/// with the contract test suite acting as the drift guard.
export const BonusDistributorAbi = [
  {
    type: "function",
    name: "postRoot",
    stateMutability: "nonpayable",
    inputs: [
      {name: "seasonId", type: "uint256"},
      {name: "root", type: "bytes32"},
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      {name: "seasonId", type: "uint256"},
      {name: "amount", type: "uint256"},
      {name: "proof", type: "bytes32[]"},
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimed",
    stateMutability: "view",
    inputs: [
      {name: "seasonId", type: "uint256"},
      {name: "user", type: "address"},
    ],
    outputs: [{type: "bool"}],
  },
  {
    type: "function",
    name: "bonusOf",
    stateMutability: "view",
    inputs: [{name: "seasonId", type: "uint256"}],
    outputs: [
      {
        type: "tuple",
        components: [
          {name: "vault", type: "address"},
          {name: "winnerToken", type: "address"},
          {name: "unlockTime", type: "uint256"},
          {name: "reserve", type: "uint256"},
          {name: "claimedTotal", type: "uint256"},
          {name: "root", type: "bytes32"},
          {name: "finalized", type: "bool"},
        ],
      },
    ],
  },
] as const;
