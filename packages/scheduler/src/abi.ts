/// Minimal `SeasonVault` ABI fragment used by the scheduler. Kept inline (not synced from
/// the contracts package) so this package stays self-contained — the four function
/// signatures here are part of the public protocol surface and rarely change. If they do,
/// CI's contract tests fail before any scheduler code lands, so drift is impossible to ship
/// silently.
export const SeasonVaultAbi = [
  {
    type: "function",
    name: "submitSettlement",
    stateMutability: "nonpayable",
    inputs: [
      {name: "winner_", type: "address"},
      {name: "losers_", type: "address[]"},
      {name: "minOuts_", type: "uint256[]"},
      {name: "rolloverRoot_", type: "bytes32"},
      {name: "totalRolloverShares_", type: "uint256"},
      {name: "liquidationDeadline_", type: "uint256"},
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "liquidate",
    stateMutability: "nonpayable",
    inputs: [
      {name: "loserToken", type: "address"},
      {name: "minOutOverride", type: "uint256"},
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "finalize",
    stateMutability: "nonpayable",
    inputs: [
      {name: "minWinnerTokensRollover", type: "uint256"},
      {name: "minWinnerTokensPol", type: "uint256"},
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimRollover",
    stateMutability: "nonpayable",
    inputs: [
      {name: "share", type: "uint256"},
      {name: "proof", type: "bytes32[]"},
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimed",
    stateMutability: "view",
    inputs: [{name: "user", type: "address"}],
    outputs: [{type: "bool"}],
  },
] as const;
