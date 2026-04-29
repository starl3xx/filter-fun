/// Minimal `FilterLauncher` ABI fragment used by the phase-advance driver. Same rationale
/// as `SeasonVaultAbi`: inline so the package is self-contained, with the contract test
/// suite acting as the drift guard.
///
/// Phase enum (matches `IFilterLauncher.Phase`):
///   0 = Launch, 1 = Filter, 2 = Finals, 3 = Settlement, 4 = Closed
export const FilterLauncherAbi = [
  {
    type: "function",
    name: "startSeason",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{name: "seasonId", type: "uint256"}],
  },
  {
    type: "function",
    name: "advancePhase",
    stateMutability: "nonpayable",
    inputs: [
      {name: "seasonId", type: "uint256"},
      {name: "target", type: "uint8"},
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setFinalists",
    stateMutability: "nonpayable",
    inputs: [
      {name: "seasonId", type: "uint256"},
      {name: "finalists", type: "address[]"},
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "currentSeasonId",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "vaultOf",
    stateMutability: "view",
    inputs: [{name: "seasonId", type: "uint256"}],
    outputs: [{type: "address"}],
  },
] as const;

/// Mirror of `IFilterLauncher.Phase`. Use the enum, not raw uint8s, when building calls.
export const Phase = {
  Launch: 0,
  Filter: 1,
  Finals: 2,
  Settlement: 3,
  Closed: 4,
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];
