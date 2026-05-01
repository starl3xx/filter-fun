# Bag-lock — opt-in creator commitment

> **Status (2026-04-30)**: contracts shipped to Base Sepolia in Epic 1.13. Web UI ships as
> the Epic 1.13-web follow-up after PR #39. **Mainnet activation is gated on the Epic 2.3
> audit.** Until then, bag-lock is testnet-only.

> **Spec refs**: §38.5 (differentiators), §38.6 (on-chain primitives), §38.7 (out-of-scope
> + security constraints), §38.8 (why this is the killer feature).

## What it is

Bag-lock is filter.fun's structural answer to "trust me, I won't dump my own bag." A
creator opts in to time-locking the tokens held by their own wallet. The lock is enforced
by the token contract itself — a lock cannot be circumvented by the protocol, by the
creator, or by anyone else.

A creator with a 60-day lock has burned the option to rug for 60 days. That's a different
category of trust signal than "trust me bro."

## What it does

When a creator calls `CreatorCommitments.commit(token, lockUntil)`:

- The mapping `unlockTimestamps[creator][token]` is set to `lockUntil`.
- Every subsequent transfer from the creator's wallet — direct `transfer`, `transferFrom`
  via approval, swap-routing through Uniswap V4, anything that reduces the creator's
  balance — reverts with `TransferLocked(from, unlockAt)` until `block.timestamp >=
  lockUntil`.
- The lock can be **extended** (call `commit` again with a later timestamp) but **never
  shortened**.
- Locks survive the protocol. There is no `unlock`, no `cancel`, no admin override, no
  pause.

Auth: only the creator-of-record (per `CreatorRegistry.creatorOf`) can call `commit` for
a given token. This is a *personal* commitment by the original launcher. If the creator
later transfers admin (Epic 1.12) to a multisig or another wallet, that admin transfer
does NOT carry the right to bag-lock. Bag-lock follows the launcher's identity, not their
control role.

## What it does NOT do

These are the false-trust risks. The web UI must surface every one of them loudly — a
holder who misunderstands the lock as broader than it is will feel betrayed when they
encounter the gap.

### 1. Pre-commit transfers escape

If the creator transferred half their bag to a second wallet BEFORE calling `commit`, that
second wallet is **not subject to the lock**. The gate is keyed off
`(creator-address, token)`. Anything that left the creator's wallet before the commit lives
outside the gate.

**UI implication**: a "creator locked X% of supply" badge must compute against the
creator's CURRENT balance at commit time, not the launch-time balance. Otherwise a creator
who pre-distributed gets credit for a lock they didn't actually take.

### 2. Buying more is fine; selling is not

Incoming transfers to the locked address still work. Fee revenue, tips, swaps from a
different wallet into the locked address — all permitted. Only outgoing transfers from
the locked address revert.

This is intentional: a lock that prevented incoming credits would block creator-fee claims
and trap the creator's revenue. The lock is about *not selling*, not *no activity*.

### 3. The lock does not cover other wallets the creator controls

Only the address that called `commit` is gated. If the creator quietly transferred to a
sibling wallet they also control before committing, they can dump from the sibling without
restriction. Detecting "common controller" addresses is an off-chain heuristic problem
(Arkham-style), not something the contract can do.

**UI implication**: surface the creator's other on-chain activity (clusters, large
transfers near commit time) so holders can form their own judgment. Don't claim the lock
covers more than the literal mapping says.

### 4. Lost keys = permanent lock

If the creator loses access to the wallet that called `commit`, the bag is permanently
locked. The protocol cannot rescue it. This is by design — an escape hatch would be the
exact same hatch a creator could use to renege on the commitment.

**UI implication**: creators must be told this BEFORE they commit. The "Lock my bag"
flow should require an acknowledgement: "If you lose this wallet, your tokens stay locked
forever. You cannot recover them."

### 5. Pre-1.13 tokens (Sepolia legacy)

Tokens deployed BEFORE the Epic 1.13 FilterFactory redeploy do not consult the commitments
contract. The gating code isn't in their bytecode. A creator of a pre-1.13 Sepolia token
who calls `commit` will see it succeed (the contract doesn't know about the token's
bytecode), but the lock will not enforce — transfers from their address will still go
through.

**Operational implication**: until the Sepolia FilterFactory is redeployed and old tokens
are wound down or migrated, do not advertise bag-lock for pre-1.13 tokens. The Sepolia
README + the in-app badge logic must explicitly exclude them.

## How to verify a creator's lock

`CreatorCommitments` exposes two view functions:

```solidity
function isLocked(address creator, address token) view returns (bool);
function unlockOf(address creator, address token) view returns (uint256); // unix ts
```

`isLocked` returns true iff `block.timestamp < unlockTimestamps[creator][token]`. `unlockOf`
returns the raw timestamp (zero if never committed).

The token contract itself doesn't expose these — it just consults `commitments.isLocked`
inside `_update`. To verify a lock from a holder's perspective, query the
`CreatorCommitments` contract directly. The contract address is in
`packages/contracts/deployments/<network>.json` under `addresses.creatorCommitments`.

## Operational caveats at deploy time

- **FilterFactory redeploy required.** New tokens consult `CreatorCommitments` because the
  factory wires the address into each token's constructor. The Sepolia FilterFactory must
  be redeployed after Epic 1.13 lands — old tokens deployed by the previous factory don't
  carry the gating code.
- **No migration path for existing tokens.** A retroactive bag-lock for tokens already
  deployed by the pre-1.13 factory would require either upgrading the token (these are
  non-upgradeable ERC-20s, by design) or wrapping it (complex; defer). The realistic
  posture is: bag-lock is for new launches; legacy tokens are advertised honestly as
  not-lockable.
- **No state in the new factory references the old one.** Redeploying the factory is a
  clean cut. Old tokens still exist, still trade, still distribute fees — they're just
  outside the bag-lock badge surface.

## Audit constraints (Epic 2.3)

The bag-lock contract is the most opinionated piece of the genesis surface. Audit must
specifically validate:

- **No way to shorten or cancel a lock.** `commit` enforces strict-`>` monotonicity; no
  other state-mutating function exists on `CreatorCommitments`.
- **No admin override.** The contract has no owner, no pause, no upgradeability, no escape
  hatch.
- **The transfer gate is consulted on every balance change** (not just direct `transfer`).
  OZ v5's `_update` hook is the single funnel — verify the override calls it on
  `transferFrom` and burn paths too.
- **The auth check uses `creatorOf`, not `adminOf`.** Admin transfers must NOT carry the
  bag-lock right.
- **Reentrancy guard on `commit`.** Defensive; no current external calls but the guard is
  load-bearing if a future change adds one.

A loud failure mode caught in audit (lock-shortening, admin override, gate bypass) would
be worse than not shipping the feature. That's why mainnet activation is gated.

## See also

- Spec §38.5 / §38.8 — strategic framing
- Spec §38.6 — on-chain primitives table
- Spec §38.7 — security constraints (audit checklist)
- `docs/runbook-operator.md` §5.6 — operator procedures
- `packages/contracts/src/CreatorCommitments.sol` — the contract
- `packages/contracts/src/FilterToken.sol` — the gate
- `packages/contracts/test/CreatorCommitments.t.sol` — coverage
