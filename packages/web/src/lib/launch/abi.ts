/// FilterLauncher ABI fragment used by the /launch page.
///
/// We mirror the slice the UI needs rather than importing the scheduler's ABI
/// — the scheduler exposes only the oracle-facing surface (startSeason,
/// advancePhase, setFinalists). The launch page reads slots / cost / status
/// and writes via launchToken, none of which the scheduler cares about. The
/// contract test suite is the drift guard on both sides.

export const FilterLauncherLaunchAbi = [
  {
    type: "function",
    name: "launchToken",
    stateMutability: "payable",
    inputs: [
      {name: "name_", type: "string"},
      {name: "symbol_", type: "string"},
      {name: "metadataURI_", type: "string"},
    ],
    outputs: [
      {name: "token", type: "address"},
      {name: "locker", type: "address"},
    ],
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
    name: "canLaunch",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "bool"}],
  },
  {
    type: "function",
    name: "getLaunchStatus",
    stateMutability: "view",
    inputs: [{name: "seasonId", type: "uint256"}],
    outputs: [
      {
        name: "s",
        type: "tuple",
        components: [
          {name: "launchCount", type: "uint256"},
          {name: "maxLaunches", type: "uint256"},
          {name: "timeRemaining", type: "uint256"},
          {name: "nextLaunchCost", type: "uint256"},
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getLaunchSlots",
    stateMutability: "view",
    inputs: [{name: "seasonId", type: "uint256"}],
    outputs: [
      {name: "tokens", type: "address[]"},
      {name: "slotIndexes", type: "uint64[]"},
      {name: "creators", type: "address[]"},
    ],
  },
  {
    type: "function",
    name: "launchCost",
    stateMutability: "view",
    inputs: [{name: "slotIndex", type: "uint256"}],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "launchesByWallet",
    stateMutability: "view",
    inputs: [
      {name: "seasonId", type: "uint256"},
      {name: "wallet", type: "address"},
    ],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "maxLaunchesPerWallet",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "refundableStakeEnabled",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "bool"}],
  },
  {
    type: "function",
    name: "MAX_LAUNCHES",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint256"}],
  },
  {
    type: "event",
    name: "TokenLaunched",
    inputs: [
      {name: "seasonId", type: "uint256", indexed: true},
      {name: "token", type: "address", indexed: true},
      {name: "locker", type: "address", indexed: true},
      {name: "creator", type: "address", indexed: false},
      {name: "isProtocolLaunched", type: "bool", indexed: false},
      {name: "slotIndex", type: "uint64", indexed: false},
      {name: "cost", type: "uint256", indexed: false},
      {name: "name", type: "string", indexed: false},
      {name: "symbol", type: "string", indexed: false},
      {name: "metadataURI", type: "string", indexed: false},
    ],
  },
] as const;

/// Domain constants — duplicated from `FilterLauncher.sol` for the cost-formula
/// preview. The contract is the source of truth; mismatches surface in the
/// preview vs. wallet quote on submit and the test suite asserts the formula
/// matches `_launchCost`.
export const MAX_LAUNCHES = 12;

/// LaunchEscrow ABI fragment — Epic 1.15c. The web only needs `claimPendingRefund`
/// (creator-self-service refund drain) plus the function/error selectors viem
/// needs for revert decoding. Full ABI lives in
/// `packages/contracts/out/LaunchEscrow.sol/LaunchEscrow.json` and the indexer
/// (`packages/indexer/abis/LaunchEscrow.ts`).
export const LaunchEscrowAbi = [
  {
    type: "function",
    name: "claimPendingRefund",
    stateMutability: "nonpayable",
    inputs: [
      {name: "seasonId", type: "uint256"},
      {name: "to", type: "address"},
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "pendingRefunds",
    stateMutability: "view",
    inputs: [
      {name: "seasonId", type: "uint256"},
      {name: "creator", type: "address"},
    ],
    outputs: [{type: "uint128"}],
  },
  {type: "error", name: "NoPendingRefund", inputs: []},
  {type: "error", name: "PendingRefundFailed", inputs: []},
  {type: "error", name: "ZeroAddress", inputs: []},
  {
    type: "event",
    name: "PendingRefundClaimed",
    inputs: [
      {name: "seasonId", type: "uint256", indexed: true},
      {name: "creator", type: "address", indexed: true},
      {name: "to", type: "address", indexed: false},
      {name: "amount", type: "uint256", indexed: false},
    ],
  },
] as const;

/// Add `launchEscrow()` getter to the launcher ABI fragment so the UI can
/// resolve the escrow address at runtime (the address isn't yet in the
/// deployment manifest's web-side `contractAddresses`).
export const FilterLauncherEscrowGetterAbi = [
  {
    type: "function",
    name: "launchEscrow",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "address"}],
  },
] as const;
