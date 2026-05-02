"use client";

/// Bag-lock commitment card for the creator admin console (Epic 1.13 web).
///
/// Replaces the `BagLockPlaceholder` with a working commit / extend form against
/// `CreatorCommitments.commit(token, lockUntil)`. The on-chain primitive is in
/// PR #43 (`packages/contracts/src/CreatorCommitments.sol`); the indexer surface
/// at `/tokens.bagLock` arrived in PR #45. Per the spec (§38.5–§38.8), this is
/// the trust signal vs Clanker — so the UI loudly states what the lock does NOT
/// do, and on Sepolia carries an audit-gate warning until Epic 2.3 unblocks
/// mainnet activation.
///
/// State branches (driven by `bagLock` from /tokens):
///   - LOCKED   → extend form, current unlock prominent, countdown.
///   - UNLOCKED → first-lock form with preset durations + custom date.
///   - LOADING  → no /tokens row yet (not in the cohort or first paint) →
///                render the unlocked branch with disabled controls.
///
/// Auth: bag-lock is the creator-of-record's commitment, NOT the admin's. The
/// CreatorCommitments contract reverts `NotCreator` if msg.sender != creator
/// even for the admin. We mirror that client-side: only the connected creator
/// can drive the form. Admin-but-not-creator falls into the read-only branch
/// with copy explaining the difference.

import {useEffect, useState} from "react";
import type {Address} from "viem";
import {useAccount, useWaitForTransactionReceipt, useWriteContract} from "wagmi";

import {contractAddresses, isDeployed} from "@/lib/addresses";
import type {BagLock} from "@/lib/arena/api";
import {CreatorCommitmentsAbi} from "@/lib/token/abis";
import {addrEq} from "@/lib/token/format";
import {C, F} from "@/lib/tokens";

import {Card} from "./Card";

export type BagLockCardProps = {
  token: Address;
  /// Creator-of-record from `CreatorRegistry.creatorOf`. `null` while the
  /// admin reads load — gate the form behind a presence check.
  creator: Address | null;
  /// Bag-lock surface from `/tokens.bagLock`. `null` when the token isn't in
  /// the current cohort (past-season tokens, first paint before /tokens
  /// resolves). Treated as "no commitment" for display.
  bagLock: BagLock | null;
  /// `"base-sepolia"` shows the audit-gate warning; `"base"` does not. The
  /// constraint per spec §2.3 is that the lock must not advertise as
  /// production-ready until the audit clears.
  chain: "base" | "base-sepolia";
};

const COMMITMENTS_ADDRESS = contractAddresses.creatorCommitments;
/// Year-from-now ceiling on the date picker. We allow a separate "lock forever"
/// button for `type(uint256).max`. Long but finite picks (10y+) are uncommon
/// and a typo at 10 years out is hard to reverse.
const MAX_LOCK_YEARS = 10;
const MIN_LOCK_BUFFER_SECONDS = 60; // round up to "in the future" for the slow click → tx path.

/// Preset durations the user can pick with one click. Each adds days from
/// `now` (not `currentUnlock`); when extending, we re-anchor to `currentUnlock`
/// so the preset always strictly extends.
const PRESETS: ReadonlyArray<{label: string; days: number}> = [
  {label: "30 days", days: 30},
  {label: "60 days", days: 60},
  {label: "90 days", days: 90},
  {label: "6 months", days: 182},
  {label: "1 year", days: 365},
];

export function BagLockCard({token, creator, bagLock, chain}: BagLockCardProps) {
  const {address: connected, isConnected} = useAccount();
  const {writeContract, data: txHash, isPending: isSubmitting, error: submitError, reset} =
    useWriteContract();
  const {isLoading: isMining, isSuccess: isMined} = useWaitForTransactionReceipt({hash: txHash});

  const isCreator = isConnected && Boolean(creator) && addrEq(connected, creator);
  const contractDeployed = isDeployed("creatorCommitments");
  const isSepolia = chain === "base-sepolia";

  const isLocked = Boolean(bagLock?.isLocked && bagLock.unlockTimestamp);
  const currentUnlockMs = bagLock?.unlockTimestamp ? bagLock.unlockTimestamp * 1000 : null;

  return (
    <Card label="Bag-lock commitment">
      <CurrentState bagLock={bagLock} />

      {!contractDeployed ? (
        <NotDeployedNotice />
      ) : (
        <CommitForm
          token={token}
          isLocked={isLocked}
          currentUnlockMs={currentUnlockMs}
          isCreator={isCreator}
          isConnected={isConnected}
          writeContract={writeContract}
          isSubmitting={isSubmitting}
          isMining={isMining}
          isMined={isMined}
          submitError={submitError ?? null}
          reset={reset}
        />
      )}

      {isSepolia && <AuditGateWarning />}

      <DoesNotDoDisclosure />
    </Card>
  );
}

// ---------------------------------------------------------------- Current state

function CurrentState({bagLock}: {bagLock: BagLock | null}) {
  if (!bagLock || !bagLock.unlockTimestamp || !bagLock.isLocked) {
    return (
      <div
        data-testid="baglock-state"
        data-locked="false"
        style={{
          padding: "12px 14px",
          borderRadius: 10,
          background: "rgba(255,255,255,0.03)",
          border: `1px solid ${C.line}`,
          marginBottom: 12,
        }}
      >
        <div style={{fontSize: 14, fontWeight: 800, color: C.text, fontFamily: F.display}}>
          Not locked
        </div>
        <div style={{marginTop: 4, fontSize: 12, color: C.dim, fontFamily: F.display, lineHeight: 1.4}}>
          Lock your bag to signal commitment to holders. Locks extend forward, never shorten.
        </div>
      </div>
    );
  }

  return <LockedState unlockTimestampSec={bagLock.unlockTimestamp} />;
}

function LockedState({unlockTimestampSec}: {unlockTimestampSec: number}) {
  // Anchor the countdown to a client clock so it ticks even between /tokens
  // polls. Re-running once per second is cheap and avoids the visual feel of a
  // stuck timer when the indexer poll cadence is 6s.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const unlockMs = unlockTimestampSec * 1000;
  const isForever = unlockTimestampSec >= Number.MAX_SAFE_INTEGER / 1000;
  const remainingMs = Math.max(0, unlockMs - nowMs);
  const dateLabel = isForever ? "forever" : new Date(unlockMs).toLocaleString();

  return (
    <div
      data-testid="baglock-state"
      data-locked="true"
      style={{
        padding: "12px 14px",
        borderRadius: 10,
        background: `linear-gradient(135deg, ${C.pink}15, ${C.red}10)`,
        border: `1px solid ${C.pink}55`,
        marginBottom: 12,
      }}
    >
      <div style={{display: "flex", alignItems: "baseline", gap: 8}}>
        <span style={{fontSize: 18, fontWeight: 900, color: C.text, fontFamily: F.display}}>▼</span>
        <span style={{fontSize: 14, fontWeight: 800, color: C.text, fontFamily: F.display}}>
          Locked
        </span>
      </div>
      <div style={{marginTop: 6, fontSize: 12, color: C.dim, fontFamily: F.display, lineHeight: 1.4}}>
        Until <strong style={{color: C.text}}>{dateLabel}</strong>
        {!isForever && (
          <>
            {" — "}
            <span data-testid="baglock-countdown" style={{fontFamily: F.mono, color: C.pink}}>
              {fmtCountdown(remainingMs)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "expiring…";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  const seconds = totalSec % 60;
  return `${minutes}m ${seconds}s`;
}

// ---------------------------------------------------------------- Commit form

function CommitForm({
  token,
  isLocked,
  currentUnlockMs,
  isCreator,
  isConnected,
  writeContract,
  isSubmitting,
  isMining,
  isMined,
  submitError,
  reset,
}: {
  token: Address;
  isLocked: boolean;
  currentUnlockMs: number | null;
  isCreator: boolean;
  isConnected: boolean;
  writeContract: ReturnType<typeof useWriteContract>["writeContract"];
  isSubmitting: boolean;
  isMining: boolean;
  isMined: boolean;
  submitError: Error | null;
  reset: () => void;
}) {
  const [chosenIso, setChosenIso] = useState<string>("");

  // Tick a clock so the picker's `min` floor and the submit-time gate stay
  // honest after the page idles. Without this, `Date.now()` would be sampled
  // once and a user who sat on the page for a few minutes could pass an
  // already-past timestamp through the client-side check (the contract would
  // still revert with `LockMustBeFuture`, but we'd burn the gas-estimate /
  // signing UX before the on-chain catch). 30s resolution is enough — the
  // datetime-local input is minute-resolution anyway.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Both bounds are cheap arithmetic; recompute every render off `nowMs` and
  // `currentUnlockMs`. NOT memoized — the prior `useMemo([currentUnlockMs])`
  // captured `Date.now()` at mount and froze the floor (bugbot finding).
  const minMs = (() => {
    const nowFloor = nowMs + MIN_LOCK_BUFFER_SECONDS * 1000;
    if (currentUnlockMs && currentUnlockMs > nowFloor) {
      // Extend mode: minimum is the next minute after current unlock.
      return Math.ceil((currentUnlockMs + 60_000) / 60_000) * 60_000;
    }
    return Math.ceil(nowFloor / 60_000) * 60_000;
  })();
  const maxMs = nowMs + MAX_LOCK_YEARS * 365 * 86_400 * 1000;

  // Reset the date input once a tx mines so the next interaction starts fresh.
  // Don't call wagmi's `reset()` here — see MetadataForm: clearing txHash
  // would flicker the success message off in a single frame.
  useEffect(() => {
    if (isMined) setChosenIso("");
  }, [isMined]);

  const chosenMs = chosenIso ? Date.parse(chosenIso) : NaN;
  const hasPick = Number.isFinite(chosenMs);
  const isTooSoon = hasPick && chosenMs < minMs;
  const isTooLate = hasPick && chosenMs > maxMs;

  const verb = isLocked ? "Extend" : "Lock";
  const buttonCopy = (() => {
    if (!isConnected) return "Connect wallet to lock";
    if (!isCreator) return "Creator only";
    if (isSubmitting) return "Sign in wallet…";
    if (isMining) return "Confirming on-chain…";
    if (!hasPick) return isLocked ? "Pick a later date to extend" : "Pick a date to lock";
    if (isTooSoon)
      return isLocked
        ? "Locks can only extend forward — pick a date after current unlock"
        : "Pick a date in the future";
    if (isTooLate) return `Max lock window is ${MAX_LOCK_YEARS} years`;
    const dateLabel = new Date(chosenMs).toLocaleDateString();
    return `${verb} until ${dateLabel}`;
  })();

  const disabled =
    !isCreator || !hasPick || isTooSoon || isTooLate || isSubmitting || isMining;

  function chooseFromPreset(days: number) {
    // Anchor presets to the larger of `now` and `currentUnlock` so a "30 days"
    // click always strictly extends an existing lock by 30 days from the
    // current unlock — not 30 days from now (which would shorten it).
    const anchor = Math.max(Date.now(), currentUnlockMs ?? 0);
    const target = anchor + days * 86_400 * 1000;
    setChosenIso(toLocalDatetimeInputValue(target));
  }

  function submit() {
    if (disabled || !hasPick) return;
    // Re-validate against a freshly-sampled clock at click-time. The 30s tick
    // keeps the displayed `minMs` close to live, but a click that lands inside
    // a tick window (or after the tab was throttled / asleep) could otherwise
    // ship a now-past timestamp. The contract would revert `LockMustBeFuture`,
    // but we'd burn signing UX before catching it.
    const liveMin =
      currentUnlockMs && currentUnlockMs > Date.now() + MIN_LOCK_BUFFER_SECONDS * 1000
        ? currentUnlockMs + 60_000
        : Date.now() + MIN_LOCK_BUFFER_SECONDS * 1000;
    if (chosenMs < liveMin) return;
    // Clear any prior tx state — wagmi otherwise carries the previous hash
    // through and `useWaitForTransactionReceipt` would still report success
    // from the old commit until the new one mines.
    reset();
    const lockUntilSec = BigInt(Math.floor(chosenMs / 1000));
    writeContract({
      address: COMMITMENTS_ADDRESS,
      abi: CreatorCommitmentsAbi,
      functionName: "commit",
      args: [token, lockUntilSec],
    });
  }

  return (
    <div style={{marginBottom: 12}}>
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: C.dim,
          marginBottom: 8,
          fontFamily: F.mono,
          fontWeight: 700,
        }}
      >
        {isLocked ? "Extend lock" : "Lock my bag"}
      </div>

      <div style={{display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10}}>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            data-testid={`baglock-preset-${p.days}`}
            onClick={() => chooseFromPreset(p.days)}
            disabled={!isCreator}
            style={{
              padding: "6px 10px",
              borderRadius: 7,
              border: `1px solid ${C.line}`,
              background: "rgba(255,255,255,0.03)",
              color: isCreator ? C.text : C.faint,
              fontFamily: F.mono,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.02em",
              cursor: isCreator ? "pointer" : "not-allowed",
            }}
          >
            +{p.label}
          </button>
        ))}
      </div>

      <input
        type="datetime-local"
        data-testid="baglock-datepicker"
        value={chosenIso}
        min={toLocalDatetimeInputValue(minMs)}
        max={toLocalDatetimeInputValue(maxMs)}
        onChange={(e) => setChosenIso(e.target.value)}
        disabled={!isCreator}
        style={{
          width: "100%",
          padding: "10px 12px",
          borderRadius: 9,
          background: "rgba(255,255,255,0.04)",
          border: `1px solid ${isTooSoon || isTooLate ? C.red : C.line}`,
          color: C.text,
          fontFamily: F.mono,
          fontSize: 13,
          outline: "none",
          colorScheme: "dark",
        }}
      />

      {hasPick && isTooSoon && (
        <p data-testid="baglock-too-soon" style={{marginTop: 6, fontSize: 11, color: C.red, fontFamily: F.mono}}>
          {isLocked
            ? `Locks can only extend forward, never shorten. Current lock ends ${currentUnlockMs ? new Date(currentUnlockMs).toLocaleString() : "—"}; pick a later date.`
            : "Lock must be at least a minute in the future."}
        </p>
      )}
      {hasPick && isTooLate && (
        <p style={{marginTop: 6, fontSize: 11, color: C.red, fontFamily: F.mono}}>
          Max lock window is {MAX_LOCK_YEARS} years. For "lock forever" support, see the docs.
        </p>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={disabled}
        data-testid="baglock-submit"
        style={{
          marginTop: 10,
          width: "100%",
          padding: "10px 14px",
          borderRadius: 9,
          border: "none",
          background: disabled
            ? "rgba(255,255,255,0.06)"
            : `linear-gradient(135deg, ${C.pink}, ${C.red})`,
          color: disabled ? C.faint : "#fff",
          fontWeight: 800,
          fontSize: 13,
          cursor: disabled ? "not-allowed" : "pointer",
          fontFamily: F.display,
          letterSpacing: "0.02em",
        }}
      >
        {buttonCopy}
      </button>

      {!isConnected && (
        <p style={{marginTop: 8, fontSize: 11, color: C.dim, fontFamily: F.display}}>
          Bag-lock is the creator-of-record's commitment. Connect the launching wallet to sign.
        </p>
      )}
      {isConnected && !isCreator && (
        <p data-testid="baglock-not-creator" style={{marginTop: 8, fontSize: 11, color: C.dim, fontFamily: F.display, lineHeight: 1.5}}>
          The lock follows the launcher's identity, not the admin role. If you transferred admin
          to a multisig, the original creator wallet must sign — by design, audit-relevant.
        </p>
      )}
      {isMined && (
        <p style={{marginTop: 8, fontSize: 12, color: C.green, fontFamily: F.mono}}>
          ▼ Locked ✓ — refreshing on the next /tokens tick.
        </p>
      )}
      {submitError && (
        <p style={{marginTop: 8, fontSize: 12, color: C.red, fontFamily: F.mono, wordBreak: "break-word"}}>
          {submitError.message}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Audit-gate warning

function AuditGateWarning() {
  return (
    <div
      role="alert"
      data-testid="baglock-audit-warning"
      style={{
        padding: "10px 12px",
        borderRadius: 9,
        background: `${C.yellow}10`,
        border: `2px solid ${C.yellow}88`,
        marginBottom: 12,
        fontFamily: F.display,
        fontSize: 12,
        color: C.text,
        lineHeight: 1.5,
      }}
    >
      <strong style={{color: C.yellow}}>⚠ Sepolia testnet only.</strong>{" "}
      Mainnet activation of bag-lock is blocked until Epic 2.3 (formal audit) completes. Locks
      committed on Sepolia are real and enforced on-chain — they are not consequential to a
      mainnet bag.
    </div>
  );
}

function NotDeployedNotice() {
  return (
    <div
      data-testid="baglock-not-deployed"
      style={{
        padding: "10px 12px",
        borderRadius: 9,
        background: `${C.faint}10`,
        border: `1px solid ${C.line}`,
        marginBottom: 12,
        fontFamily: F.display,
        fontSize: 12,
        color: C.dim,
        lineHeight: 1.5,
      }}
    >
      <strong style={{color: C.text}}>CreatorCommitments not deployed on this network yet.</strong>{" "}
      The form unlocks once the deploy manifest carries a non-zero address. Mainnet activation
      is gated on the Epic 2.3 audit.
    </div>
  );
}

// ---------------------------------------------------------------- Limitations disclosure

const LIMITATIONS: ReadonlyArray<{title: string; body: string}> = [
  {
    title: "Pre-commit transfers escape",
    body:
      "if you sent tokens to another wallet before locking, those are NOT subject to the lock.",
  },
  {
    title: "Doesn't cover sibling wallets",
    body: "only the creator-of-record's address is gated.",
  },
  {
    title: "Lost keys = permanent lock",
    body: "there is no recovery; the protocol cannot unlock.",
  },
  {
    title: "Pre-1.13 tokens not gated",
    body: "tokens deployed before bag-lock contracts shipped are forever ungated.",
  },
  {
    title: "Inbound transfers still allowed",
    body: "fees, tips, airdrops can still reach the locked address.",
  },
];

function DoesNotDoDisclosure() {
  return (
    <details
      data-testid="baglock-does-not-do"
      open
      style={{
        marginTop: 0,
        background: "rgba(255,255,255,0.02)",
        border: `1px solid ${C.line}`,
        borderRadius: 9,
        padding: "10px 12px",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: C.dim,
          fontFamily: F.mono,
          fontWeight: 700,
        }}
      >
        What this lock doesn't do
      </summary>
      <p style={{margin: "8px 0 6px", fontSize: 11, color: C.dim, fontFamily: F.display, lineHeight: 1.5}}>
        Holders should know the gaps. Surfacing them up-front is what makes the lock credible.
      </p>
      <ol style={{margin: "0 0 6px", paddingLeft: 18, fontSize: 12, color: C.text, fontFamily: F.display, lineHeight: 1.5}}>
        {LIMITATIONS.map((l) => (
          <li key={l.title} style={{marginBottom: 4}}>
            <strong>{l.title}</strong> — {l.body}
          </li>
        ))}
      </ol>
      <a
        href="https://docs.filter.fun/creators/bag-lock"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-block",
          marginTop: 4,
          fontSize: 11,
          fontFamily: F.mono,
          color: C.cyan,
          textDecoration: "underline",
        }}
      >
        Read the full bag-lock doc ↗
      </a>
    </details>
  );
}

// ---------------------------------------------------------------- helpers

/// Format a millisecond epoch as a `YYYY-MM-DDTHH:mm` string in the LOCAL time
/// zone — what `<input type="datetime-local">` reads/writes. `new Date(ms)
/// .toISOString()` would format in UTC and the picker would silently reinterpret
/// the value, shifting the user's intent by their local offset.
function toLocalDatetimeInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

