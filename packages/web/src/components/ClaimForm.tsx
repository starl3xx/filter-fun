"use client";

import {useEffect, useState, type ReactNode} from "react";
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
}

export function ClaimForm({
  title,
  subtitle,
  numericLabel,
  jsonPlaceholder,
  parseJson,
  buildCall,
  buildClaimedRead,
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
      <h1 style={{fontSize: 24, marginBottom: 8}}>{title}</h1>
      <p style={{color: "var(--muted)", marginTop: 0, marginBottom: 32}}>{subtitle}</p>

      <Section label="1. Paste your claim entry">
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={jsonPlaceholder}
          rows={8}
          style={{
            width: "100%",
            background: "#18181b",
            color: "var(--fg)",
            border: "1px solid var(--border)",
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
          {isConnected && (
            <Row k="Status">
              <StatusBadge claimed={isClaimed} unknown={alreadyClaimed === undefined && !isMined} />
            </Row>
          )}
        </Section>
      )}

      {parsed && (
        <Section label="3. Submit">
          {!isConnected ? (
            <p style={{color: "var(--muted)"}}>Connect a wallet to claim.</p>
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
                <p style={{marginTop: 12, color: "var(--muted)", fontSize: 14}}>
                  tx: <code>{txHash}</code>
                </p>
              )}
              {submitError && <ErrorRow>{submitError.message}</ErrorRow>}
            </>
          )}
        </Section>
      )}
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
/// enabled because the chain is wrong). We treat null as "no balance"
/// rather than "unknown — allow" because shipping the user into a sign-then-
/// fail path on a 0-balance wallet is exactly what this guard is here to
/// prevent. The CTA stays disabled until balance is positive.
export interface ClaimPreflightInputs {
  walletChain: {id: number; name: string} | null;
  expectedChain: {id: number; name: string; nativeCurrencySymbol: string};
  balanceWei: bigint | null;
}

export type ClaimPreflightResult =
  | {ok: true}
  | {ok: false; reason: "wrong-chain" | "no-balance"; message: string};

export function computeClaimPreflight(input: ClaimPreflightInputs): ClaimPreflightResult {
  const {walletChain, expectedChain: ec, balanceWei} = input;
  if (walletChain?.id !== ec.id) {
    return {
      ok: false,
      reason: "wrong-chain",
      message: `Connected to chain ${walletChain?.name ?? walletChain?.id ?? "unknown"}; switch to ${ec.name} to claim.`,
    };
  }
  if (balanceWei === null || balanceWei === 0n) {
    return {
      ok: false,
      reason: "no-balance",
      message: `Wallet has 0 ${ec.nativeCurrencySymbol} on ${ec.name} — top up enough to cover gas before submitting.`,
    };
  }
  return {ok: true};
}

function StatusBadge({claimed, unknown}: {claimed: boolean; unknown: boolean}) {
  if (unknown) return <span style={{color: "var(--muted)"}}>checking…</span>;
  if (claimed) return <span style={{color: "var(--muted)"}}>already claimed</span>;
  return <span style={{color: "var(--fg)"}}>eligible</span>;
}

function Section({label, children}: {label: string; children: ReactNode}) {
  return (
    <section style={{marginBottom: 32}}>
      <h2 style={{fontSize: 14, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1, margin: "0 0 12px"}}>
        {label}
      </h2>
      {children}
    </section>
  );
}

function Row({k, children}: {k: string; children: ReactNode}) {
  return (
    <div style={{display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)"}}>
      <span style={{color: "var(--muted)"}}>{k}</span>
      <span>{children}</span>
    </div>
  );
}

function ErrorRow({children}: {children: ReactNode}) {
  return <p style={{color: "var(--accent)", marginTop: 12, fontSize: 14}}>{children}</p>;
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
        border: "1px solid var(--border)",
        background: "rgba(255, 85, 119, 0.08)",
        color: "var(--fg)",
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
