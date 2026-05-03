"use client";

import {useEffect, useState, type CSSProperties, type ReactNode} from "react";
import type {Address, Hex} from "viem";
import {isAddress} from "viem";
import {
  useAccount,
  useBalance,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import type {ContractCallShape} from "@filter-fun/scheduler";

import {C} from "@/lib/tokens";
import {chain as expectedChain} from "@/lib/wagmi";

/// Shape of a single user's claim entry, parsed from the JSON the oracle publishes.
/// Both rollover (share-based) and bonus (amount-based) flows feed into this same shape;
/// the per-flow page configures `numericLabel` and the call builder.
export interface ParsedClaim {
  seasonId: bigint;
  contract: Address;
  /// "share" for rollover, "amount" for bonus — purely cosmetic, drives the rendered label.
  numeric: bigint;
  proof: ReadonlyArray<Hex>;
}

export interface ClaimFormProps {
  /// Title shown above the form (e.g. "Claim rollover").
  title: string;
  /// One-line subtitle clarifying what the user gets.
  subtitle: string;
  /// Label for the numeric field — e.g. "share" or "amount (WETH)".
  numericLabel: string;
  /// Example JSON shown in the textarea. Per-flow because rollover and bonus payloads
  /// have different field names (`vault`/`share` vs `distributor`/`amount`).
  jsonPlaceholder: string;
  /// Parses + validates the pasted JSON. Throws Error with a user-readable message on
  /// invalid input. Each flow's payload shape differs; the parser knows which fields to read.
  parseJson: (raw: string) => ParsedClaim;
  /// Builds the contract call. Wired to scheduler's call builders so we share the ABI.
  buildCall: (claim: ParsedClaim) => ContractCallShape;
  /// Builds the `claimed(...)` read call. Per-flow because rollover keys claims on
  /// `address` only (one vault per season) while bonus keys on `(seasonId, address)`.
  buildClaimedRead: (claim: ParsedClaim, user: Address) => ContractCallShape;
  /// Optional content rendered ABOVE the title, INSIDE the `<main>` so it
  /// inherits the global 720px max-width constraint. Bugbot caught (PR #81
  /// round 2) that callers rendering siblings of `<ClaimForm/>` in a fragment
  /// produced full-viewport-width helper cards while the form below stayed
  /// 720px-capped — the slots route the content through the constraint.
  headerSlot?: ReactNode;
  /// Optional content rendered BELOW the form, inside the same `<main>`.
  footerSlot?: ReactNode;
}

export function ClaimForm({
  title,
  subtitle,
  numericLabel,
  jsonPlaceholder,
  parseJson,
  buildCall,
  buildClaimedRead,
  headerSlot,
  footerSlot,
}: ClaimFormProps) {
  const {address, isConnected, chain: walletChain} = useAccount();
  const {switchChain, isPending: isSwitchingChain} = useSwitchChain();
  const [raw, setRaw] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedClaim | null>(null);

  const {writeContract, data: txHash, isPending: isSubmitting, error: submitError, reset} = useWriteContract();
  const {isLoading: isMining, isSuccess: isMined} = useWaitForTransactionReceipt({hash: txHash});

  // Phase 1 audit C-6 (Phase 1 audit 2026-05-01): the claim button previously
  // wrote the contract call without any preflight — wrong chain or empty
  // wallet would surface as a wagmi/RPC error AFTER the user signed,
  // confusing an already friction-laden post-filter flow. Read both checks up
  // front so we can disable the CTA + render a targeted explanation. We pull
  // ETH balance (not a token balance) because the claim is a regular EIP-1559
  // tx whose gas is paid in the chain's native asset.
  const onCorrectChain = walletChain?.id === expectedChain.id;
  const {data: balance} = useBalance({
    address,
    chainId: expectedChain.id,
    query: {enabled: isConnected && onCorrectChain},
  });
  const balanceWei = balance ? balance.value : null;
  const preflight = computeClaimPreflight({
    walletChain: walletChain ? {id: walletChain.id, name: walletChain.name} : null,
    expectedChain: {
      id: expectedChain.id,
      name: expectedChain.name,
      nativeCurrencySymbol: expectedChain.nativeCurrency.symbol,
    },
    balanceWei,
  });

  // Read `claimed[user]` once we have both a parsed payload and a connected wallet.
  const claimedCall = parsed && address ? buildClaimedRead(parsed, address) : null;
  const {data: alreadyClaimed, refetch: refetchClaimed} = useReadContract({
    address: claimedCall?.address,
    abi: claimedCall?.abi as never,
    functionName: claimedCall?.functionName,
    args: claimedCall?.args as never,
    query: {enabled: claimedCall !== null},
  });

  // After the tx mines, refetch so the badge flips from "eligible" → "already claimed"
  // without a manual refresh. NOT in writeContract's onSuccess — that fires when the
  // hash is broadcast to mempool, before any state change has actually landed on-chain.
  useEffect(() => {
    if (isMined) void refetchClaimed();
  }, [isMined, refetchClaimed]);

  function handleParse() {
    setParseError(null);
    setParsed(null);
    reset();
    try {
      const claim = parseJson(raw);
      if (!isAddress(claim.contract)) throw new Error("contract address is malformed");
      setParsed(claim);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleClaim() {
    if (!parsed) return;
    const call = buildCall(parsed);
    writeContract({
      address: call.address,
      // viem's writeContract is strict about ABI typing; the structural ContractCallShape
      // erases that. Casting is safe because the call builders own the ABI binding.
      abi: call.abi as never,
      functionName: call.functionName,
      args: call.args as never,
    });
  }

  const isClaimed = alreadyClaimed === true || isMined;

  return (
    <main>
      {headerSlot}
      <h1 style={{fontSize: 24, marginBottom: 8}}>{title}</h1>
      <p style={{color: C.dim, marginTop: 0, marginBottom: 32}}>{subtitle}</p>

      <Section label="1. Paste your claim entry">
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={jsonPlaceholder}
          rows={8}
          style={{
            width: "100%",
            background: "#18181b",
            color: C.text,
            border: `1px solid ${C.line}`,
            borderRadius: 6,
            padding: 12,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 13,
          }}
        />
        <button onClick={handleParse} disabled={raw.trim().length === 0} style={{marginTop: 12}}>
          Parse
        </button>
        {parseError && <ErrorRow>{parseError}</ErrorRow>}
      </Section>

      {parsed && (
        <Section label="2. Review">
          <Row k="Season">{parsed.seasonId.toString()}</Row>
          <Row k="Contract">
            <code>{parsed.contract}</code>
          </Row>
          <Row k={numericLabel}>{parsed.numeric.toString()}</Row>
          <Row k="Proof depth">{parsed.proof.length}</Row>
          {/* Audit M-Web-1 (Phase 1, 2026-05-02): always render the Status
              row so a wallet connect (or the eligibility read settling) does
              not cause a layout shift. The badge itself reserves a fixed
              min-height so the text swap from "checking…" → "eligible" /
              "already claimed" doesn't flicker the row height. The
              disconnected message is informational and replaces the badge
              instead of hiding the entire row. */}
          <Row k="Status">
            {isConnected ? (
              <StatusBadge claimed={isClaimed} unknown={alreadyClaimed === undefined && !isMined} />
            ) : (
              <span style={{color: C.dim, display: "inline-block", minHeight: 18, lineHeight: "18px"}}>
                Connect wallet to check status
              </span>
            )}
          </Row>
        </Section>
      )}

      {parsed && (
        <Section label="3. Submit">
          {!isConnected ? (
            <p style={{color: C.dim}}>Connect a wallet to claim.</p>
          ) : (
            <>
              {/* Audit C-6 preflight: render the targeted reason BEFORE the
                  CTA so the user understands why it's disabled, and offer the
                  one-click fix when the chain is wrong. */}
              {!preflight.ok && (
                <PreflightWarning
                  message={preflight.message}
                  action={
                    preflight.reason === "wrong-chain"
                      ? {
                          label: isSwitchingChain ? "Switching…" : `Switch to ${expectedChain.name}`,
                          disabled: isSwitchingChain,
                          onClick: () => switchChain({chainId: expectedChain.id}),
                        }
                      : null
                  }
                />
              )}
              <button
                onClick={handleClaim}
                disabled={isSubmitting || isMining || isClaimed || !preflight.ok}
              >
                {isClaimed ? "Already claimed" : isMining ? "Confirming…" : isSubmitting ? "Submitting…" : "Claim"}
              </button>
              {txHash && (
                <p style={{marginTop: 12, color: C.dim, fontSize: 14}}>
                  tx: <code>{txHash}</code>
                </p>
              )}
              {submitError && <ErrorRow>{humanizeClaimError(submitError.message)}</ErrorRow>}
            </>
          )}
        </Section>
      )}
      {footerSlot}
    </main>
  );
}

/// Audit C-6 (Phase 1 audit 2026-05-01): pure decision function for the
/// claim CTA's preflight gate. Extracted so the wagmi-bound `ClaimForm`
/// component stays test-light while the actual *policy* (which precondition
/// fires first, what message renders) is unit-testable without mocking
/// `useAccount` / `useBalance`.
///
/// Order of checks is load-bearing: chain mismatch is reported BEFORE
/// balance because (a) switching chain typically refetches balance — a
/// "no balance" error on the wrong chain would be misleading and (b) the
/// user can't sign on the wrong chain anyway, so the chain-fix CTA is the
/// useful next action.
///
/// `balanceWei === null` means the read hasn't resolved yet (or wasn't
/// enabled because the chain is wrong). We treat null as fail-closed
/// (`balance-loading` reason) rather than "unknown — allow" because shipping
/// the user into a sign-then-fail path is exactly what this guard prevents.
/// `balanceWei === 0n` is a separate `no-balance` reason so the user-facing
/// copy doesn't claim "Wallet has 0 ETH" during the brief loading window
/// after a chain switch (bugbot finding on PR #57). The CTA stays disabled
/// for both reasons; only the message differs.
export interface ClaimPreflightInputs {
  walletChain: {id: number; name: string} | null;
  expectedChain: {id: number; name: string; nativeCurrencySymbol: string};
  balanceWei: bigint | null;
}

export type ClaimPreflightResult =
  | {ok: true}
  | {ok: false; reason: "wrong-chain" | "no-balance" | "balance-loading"; message: string};

export function computeClaimPreflight(input: ClaimPreflightInputs): ClaimPreflightResult {
  const {walletChain, expectedChain: ec, balanceWei} = input;
  if (walletChain?.id !== ec.id) {
    return {
      ok: false,
      reason: "wrong-chain",
      message: `Connected to chain ${walletChain?.name ?? walletChain?.id ?? "unknown"}; switch to ${ec.name} to claim.`,
    };
  }
  if (balanceWei === null) {
    return {
      ok: false,
      reason: "balance-loading",
      message: `Checking ${ec.nativeCurrencySymbol} balance on ${ec.name}…`,
    };
  }
  if (balanceWei === 0n) {
    return {
      ok: false,
      reason: "no-balance",
      message: `Wallet has 0 ${ec.nativeCurrencySymbol} on ${ec.name} — top up enough to cover gas before submitting.`,
    };
  }
  return {ok: true};
}

/// Audit M-Web-1 (Phase 1, 2026-05-02): the badge renders into a
/// fixed-min-height inline-block so the text swap from "checking…" → final
/// state doesn't shift the surrounding Status row. Pre-fix the badge was a
/// bare span whose intrinsic height matched whatever string was in it; in
/// practice the strings are all ~14 chars so the visible flicker came from
/// the row itself appearing/disappearing on disconnect, but reserving the
/// height also stops a future variant ("⏳ verifying merkle proof…", say)
/// from re-introducing the same bug.
function StatusBadge({claimed, unknown}: {claimed: boolean; unknown: boolean}) {
  const baseStyle: CSSProperties = {display: "inline-block", minHeight: 18, lineHeight: "18px"};
  if (unknown) return <span style={{...baseStyle, color: C.dim}}>checking…</span>;
  if (claimed) return <span style={{...baseStyle, color: C.dim}}>already claimed</span>;
  return <span style={{...baseStyle, color: C.text}}>eligible</span>;
}

function Section({label, children}: {label: string; children: ReactNode}) {
  return (
    <section style={{marginBottom: 32}}>
      <h2 style={{fontSize: 14, color: C.dim, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 12px"}}>
        {label}
      </h2>
      {children}
    </section>
  );
}

function Row({k, children}: {k: string; children: ReactNode}) {
  return (
    <div style={{display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.line}`}}>
      <span style={{color: C.dim}}>{k}</span>
      <span>{children}</span>
    </div>
  );
}

function ErrorRow({children}: {children: ReactNode}) {
  return <p style={{color: C.pink, marginTop: 12, fontSize: 14}}>{children}</p>;
}

/// Audit M-Ux-9 (Phase 1, 2026-05-03): map known on-chain revert
/// signatures to friendly, actionable messages so a Merkle-proof failure
/// (the most common claim error) doesn't surface as raw
/// "execution reverted (0x09bde339)" hex. The wagmi/viem error message
/// includes either the decoded error name (when the ABI carries the
/// custom error definition — `useWriteContract` does pass the ABI) or
/// the raw selector hex (when decoding fails). We match on BOTH so the
/// fix works regardless of which path viem takes for a given chain /
/// RPC combination.
///
/// Selectors are first 4 bytes of keccak256(signature) — verified via
/// `viem.toFunctionSelector()` at PR-write time so a typo here can't
/// silently mismatch a real on-chain revert:
///   - InvalidProof()              → 0x09bde339   (TournamentVault, BonusDistributor)
///   - AlreadyClaimed()            → 0x646cf558   (TournamentVault, BonusDistributor)
///   - WrongPhase()                → 0xe2586bcc   (TournamentVault — claim before t.phase == Settled)
///   - BonusLocked()               → 0xf1192f69   (TournamentVault — bonus claim before unlockTime)
///   - AlreadySettled()            → 0x560ff900   (TournamentVault — admin-side, oracle settle*)
///   - AlreadyFunded()             → 0x5adf6387   (BonusDistributor — admin-only, not a user error)
///   - ClaimExceedsAllocation()    → 0x12f02dca   (TournamentVault — share > allocated)
///
/// Bugbot caught (PR #81) that the pre-fix `AlreadySettled()` mapping was
/// attached to the wrong revert: claim functions in TournamentVault revert
/// with `WrongPhase()` (not `AlreadySettled()`) when called pre-settlement
/// — `AlreadySettled()` is only thrown by the oracle-only `settle*` paths
/// (and means "already settled, can't settle again", not "settlement
/// hasn't completed yet"). Re-anchored the user-facing settlement-timing
/// copy to `WrongPhase()` and demoted `AlreadySettled()` to a separate,
/// admin-flavoured message in case it ever surfaces via this code path.
///
/// The "user rejected" branch is a wallet-side error not an on-chain
/// revert, but it's the second-most-common error here and surfaces with
/// a known string from every wallet (MetaMask, Rabby, Coinbase Wallet,
/// WalletConnect injected providers); folding it in here keeps all the
/// "the claim didn't work" copy in one place.
///
/// Returned string is the message to render. Falls back to a generic
/// "Claim failed" header + the raw message in a small muted line so
/// the user still has the original hex / decoded name to share with
/// support if the friendly text doesn't help.
export function humanizeClaimError(raw: string | null | undefined): string {
  if (!raw) return "Claim failed.";
  if (/InvalidProof\(\)|0x09bde339/i.test(raw)) {
    return "This claim isn't valid for your wallet. Double-check that you pasted the JSON for THIS wallet — the proof is bound to the address it was issued for. If you switched wallets after the cut, reconnect the original one.";
  }
  if (/AlreadyClaimed\(\)|0x646cf558/i.test(raw)) {
    return "This claim has already been redeemed. The funds went to your wallet on the original claim transaction — check your balance or transaction history.";
  }
  // Bugbot (PR #81): WrongPhase() is what TournamentVault.claimQuarterly*/
  // claimAnnual* revert with when called before t.phase == Settled — this
  // is the actual "claim too early" surface. AlreadySettled() (below) is
  // unreachable from claim paths but kept mapped in case it ever surfaces
  // via a different caller wired through this same humanizer.
  if (/WrongPhase\(\)|0xe2586bcc/i.test(raw)) {
    return "The week's settlement hasn't completed yet. Claims open shortly after the FILTER_FIRED event lands and the Merkle root publishes — try again in a moment.";
  }
  if (/BonusLocked\(\)|0xf1192f69/i.test(raw)) {
    return "The hold-bonus window for this season hasn't opened yet. Bonuses unlock 14 days after settlement to reward holders who don't sell — come back after the unlock date listed on the bonus page.";
  }
  if (/AlreadySettled\(\)|0x560ff900/i.test(raw)) {
    return "This season has already been settled. If you're trying to claim, your claim should already be open — try refreshing the page; if you're an operator, the settle call has already been made.";
  }
  if (/ClaimExceedsAllocation\(\)|0x12f02dca/i.test(raw)) {
    return "The amount in this claim exceeds your allocated share. The JSON may be from a different season or a different wallet — re-fetch your claim.";
  }
  if (/User rejected the request|user rejected|UserRejectedRequestError/i.test(raw)) {
    return "Transaction was rejected in your wallet. Click Claim again and approve in the wallet popup to retry.";
  }
  // Unknown — render a header + the raw underneath so the user can copy
  // it for support. Truncate the raw at 240 chars so a long viem stack
  // trace doesn't push the rest of the form off-screen.
  const trimmed = raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
  return `Claim failed. ${trimmed}`;
}

/// Audit C-6 (Phase 1 audit 2026-05-01) preflight chip. Renders inline above
/// the Claim button when wallet is connected but a precondition (chain or
/// gas balance) isn't met. The chain-wrong variant offers a one-click switch
/// via wagmi's `useSwitchChain`; the no-balance variant is informational
/// only because we can't fund the wallet for the user.
function PreflightWarning({
  message,
  action,
}: {
  message: string;
  action: {label: string; disabled?: boolean; onClick: () => void} | null;
}) {
  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        marginBottom: 12,
        padding: "10px 12px",
        borderRadius: 6,
        border: `1px solid ${C.line}`,
        background: "rgba(255, 85, 119, 0.08)",
        color: C.text,
        fontSize: 13,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <span>{message}</span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          style={{alignSelf: "flex-start"}}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
