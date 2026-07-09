/// FilterLauncher ABI fragment used by the /launch page.
///
/// We mirror the slice the UI needs rather than importing the scheduler's ABI
/// — the scheduler exposes only the oracle-facing surface (startSeason,
/// advancePhase, setFinalists). The launch page reads slots / cost / status
/// and writes via reserve, none of which the scheduler cares about. The
/// contract test suite is the drift guard on both sides.
///
/// Epic 1.15a drift fix: the deployed contract's ONLY public entry point is
/// `reserve(string ticker, string metadataURI)` (spec §46.9) — the legacy
/// `launchToken(name, symbol, metadataURI)` never shipped. The canonical
/// on-chain symbol IS the normalized ticker (TickerLib strips `$`, trims,
/// uppercases); the display name travels only in the pinned metadata. The
/// custom errors below are declared so viem can decode revert selectors into
/// names for `useLaunchToken.humanError` — without the ABI entries every
/// revert would surface as an opaque `0x...` selector. Pinned by
/// `test/launch/reserveAbi.test.ts` so the launchToken drift can't recur.

export const FilterLauncherLaunchAbi = [
  {
    type: "function",
    name: "reserve",
    stateMutability: "payable",
    inputs: [
      {name: "ticker", type: "string"},
      {name: "metadataURI", type: "string"},
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
  // ---- reserve() revert surface (spec §46.9, one custom error per gate) ----
  // Ordered to mirror the contract's validation cascade so a reader can line
  // this block up against FilterLauncher.reserve step-by-step.
  {type: "error", name: "WrongPhase", inputs: []},
  {type: "error", name: "SeasonAlreadyAborted", inputs: []},
  {type: "error", name: "WindowClosed", inputs: []},
  {type: "error", name: "AlreadyReserved", inputs: []},
  {type: "error", name: "SlotsExhausted", inputs: []},
  {type: "error", name: "InvalidTickerFormat", inputs: [{name: "ticker", type: "string"}]},
  {type: "error", name: "TickerBlocklisted", inputs: []},
  {type: "error", name: "TickerWinnerReserved", inputs: []},
  {type: "error", name: "TickerTaken", inputs: []},
  {type: "error", name: "InsufficientEscrow", inputs: []},
  {type: "error", name: "RefundFailed", inputs: []},
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
  {
    type: "function",
    name: "reservedAtOf",
    stateMutability: "view",
    inputs: [
      {name: "seasonId", type: "uint256"},
      {name: "creator", type: "address"},
    ],
    outputs: [{type: "uint64"}],
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

/// `lens()` getter — same runtime-resolution pattern as `launchEscrow()` above.
/// The launcher's read-only convenience views were externalized to
/// `LauncherLens` to keep the launcher under EIP-170 (its own NatSpec: "lives
/// outside the launcher's bytecode"); the web resolves the companion address
/// off the launcher once per session (wagmi caches the immutable read).
export const FilterLauncherLensGetterAbi = [
  {
    type: "function",
    name: "lens",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "address"}],
  },
] as const;

/// LauncherLens ABI fragment — the read-only companion the /launch page polls.
/// Epic 1.15a drift fix (same pass as the `reserve` rename above): these views
/// used to be declared on the launcher ABI, but `getLaunchStatus` /
/// `getLaunchSlots` / `canReserve` only exist on the lens — reads against the
/// launcher address revert. `canLaunch` / `launchesByWallet` /
/// `maxLaunchesPerWallet` are GONE from the contracts entirely (spec §46 made
/// the per-wallet cap structural in `LaunchEscrow`: one reservation per wallet
/// per season, checked via `reservedAtOf`).
export const LauncherLensAbi = [
  {
    type: "function",
    name: "canReserve",
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
    name: "reservationCount",
    stateMutability: "view",
    inputs: [{name: "seasonId", type: "uint256"}],
    outputs: [{type: "uint256"}],
  },
] as const;
