/// Minimal ABI fragments for the Creator Admin Console (Epic 1.11).
///
/// Inlined here rather than imported from `@filter-fun/contracts` because the
/// contracts package only ships Solidity source — the ABIs we need are a small
/// subset (the admin surface from PR #38 + the bits of FilterLauncher /
/// CreatorFeeDistributor we read from). The contract test suite is the drift
/// guard: if a function's signature changes here without a matching change in
/// the contract, every wagmi call short-circuits with no on-chain effect, and
/// the corresponding test fails loudly.

// ============================================================ CreatorRegistry

export const CreatorRegistryAbi = [
  // Reads — used by useTokenAdmin.
  {
    type: "function",
    name: "creatorOf",
    stateMutability: "view",
    inputs: [{name: "token", type: "address"}],
    outputs: [{type: "address"}],
  },
  {
    type: "function",
    name: "adminOf",
    stateMutability: "view",
    inputs: [{name: "token", type: "address"}],
    outputs: [{type: "address"}],
  },
  {
    type: "function",
    name: "recipientOf",
    stateMutability: "view",
    inputs: [{name: "token", type: "address"}],
    outputs: [{type: "address"}],
  },
  {
    type: "function",
    name: "pendingAdminOf",
    stateMutability: "view",
    inputs: [{name: "token", type: "address"}],
    outputs: [{type: "address"}],
  },
  {
    type: "function",
    name: "metadataURIOf",
    stateMutability: "view",
    inputs: [{name: "token", type: "address"}],
    outputs: [{type: "string"}],
  },
  {
    type: "function",
    name: "launchedAt",
    stateMutability: "view",
    inputs: [{name: "token", type: "address"}],
    outputs: [{type: "uint256"}],
  },
  // Writes — used by the right-column action forms.
  {
    type: "function",
    name: "setMetadataURI",
    stateMutability: "nonpayable",
    inputs: [
      {name: "token", type: "address"},
      {name: "uri", type: "string"},
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setCreatorRecipient",
    stateMutability: "nonpayable",
    inputs: [
      {name: "token", type: "address"},
      {name: "newRecipient", type: "address"},
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "nominateAdmin",
    stateMutability: "nonpayable",
    inputs: [
      {name: "token", type: "address"},
      {name: "pendingAdmin", type: "address"},
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "acceptAdmin",
    stateMutability: "nonpayable",
    inputs: [{name: "token", type: "address"}],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelNomination",
    stateMutability: "nonpayable",
    inputs: [{name: "token", type: "address"}],
    outputs: [],
  },
] as const;

// ============================================================ CreatorCommitments
// Epic 1.13 bag-lock surface. Only the read + write fragments the admin console
// touches — `isLocked` is consumed by the on-chain transfer gate and isn't read
// from the UI (we render off `unlockOf`, which is the timestamp the badge needs).

export const CreatorCommitmentsAbi = [
  {
    type: "function",
    name: "unlockOf",
    stateMutability: "view",
    inputs: [
      {name: "creator", type: "address"},
      {name: "token", type: "address"},
    ],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "commit",
    stateMutability: "nonpayable",
    inputs: [
      {name: "token", type: "address"},
      {name: "lockUntil", type: "uint256"},
    ],
    outputs: [],
  },
] as const;

// ============================================================ CreatorFeeDistributor
// Epic 1.16 (spec §10.3 + §10.6, locked 2026-05-02): creator-fee accrual is perpetual.
// `eligible(token)` was removed — the time + filter cap it expressed no longer exists.
// `isDisabled(token)` is its replacement: true only after the multisig has invoked the
// emergency-disable path (sanctioned/compromised recipient).

export const CreatorFeeDistributorAbi = [
  {
    type: "function",
    name: "pendingClaim",
    stateMutability: "view",
    inputs: [{name: "token", type: "address"}],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "isDisabled",
    stateMutability: "view",
    inputs: [{name: "token", type: "address"}],
    outputs: [{type: "bool"}],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{name: "token", type: "address"}],
    outputs: [{name: "amount", type: "uint256"}],
  },
] as const;

// ============================================================ FilterLauncher
// Only the read shape needed by the admin console. Phase-advance / startSeason
// already live in `@filter-fun/scheduler`; we don't re-export here.

export const FilterLauncherReadAbi = [
  {
    type: "function",
    name: "currentSeasonId",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "phaseOf",
    stateMutability: "view",
    inputs: [{name: "seasonId", type: "uint256"}],
    outputs: [{type: "uint8"}],
  },
  {
    type: "function",
    name: "launchInfoOf",
    stateMutability: "view",
    inputs: [
      {name: "seasonId", type: "uint256"},
      {name: "token", type: "address"},
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          {name: "slotIndex", type: "uint64"},
          {name: "costPaid", type: "uint128"},
          {name: "stakeAmount", type: "uint128"},
          {name: "refunded", type: "bool"},
          {name: "filteredEarly", type: "bool"},
        ],
      },
    ],
  },
  {
    type: "function",
    name: "entryOf",
    stateMutability: "view",
    inputs: [
      {name: "seasonId", type: "uint256"},
      {name: "token", type: "address"},
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          {name: "token", type: "address"},
          {name: "pool", type: "address"},
          {name: "feeSplitter", type: "address"},
          {name: "creator", type: "address"},
          {name: "isProtocolLaunched", type: "bool"},
          {name: "isFinalist", type: "bool"},
        ],
      },
    ],
  },
] as const;

// Phase enum — mirrors IFilterLauncher.Phase. Re-exported here so the admin
// page doesn't need a second import from `@filter-fun/scheduler`.
export const Phase = {
  Launch: 0,
  Filter: 1,
  Finals: 2,
  Settlement: 3,
  Closed: 4,
} as const;
export type PhaseId = (typeof Phase)[keyof typeof Phase];
