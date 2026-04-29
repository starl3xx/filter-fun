"use client";

import {useState, type ReactNode} from "react";
import type {Address, Hex} from "viem";
import {isAddress} from "viem";
import {useAccount, useWaitForTransactionReceipt, useWriteContract} from "wagmi";

import type {ContractCallShape} from "@filter-fun/scheduler";

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
  /// Parses + validates the pasted JSON. Throws Error with a user-readable message on
  /// invalid input. Each flow's payload shape differs; the parser knows which fields to read.
  parseJson: (raw: string) => ParsedClaim;
  /// Builds the contract call. Wired to scheduler's call builders so we share the ABI.
  buildCall: (claim: ParsedClaim) => ContractCallShape;
}

export function ClaimForm({title, subtitle, numericLabel, parseJson, buildCall}: ClaimFormProps) {
  const {isConnected} = useAccount();
  const [raw, setRaw] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedClaim | null>(null);

  const {writeContract, data: txHash, isPending: isSubmitting, error: submitError, reset} = useWriteContract();
  const {isLoading: isMining, isSuccess: isMined} = useWaitForTransactionReceipt({hash: txHash});

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

  return (
    <main>
      <h1 style={{fontSize: 24, marginBottom: 8}}>{title}</h1>
      <p style={{color: "var(--muted)", marginTop: 0, marginBottom: 32}}>{subtitle}</p>

      <Section label="1. Paste your claim entry">
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder='{"seasonId": "1", "vault": "0x…", "share": "100", "proof": ["0x…"]}'
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
        </Section>
      )}

      {parsed && (
        <Section label="3. Submit">
          {!isConnected ? (
            <p style={{color: "var(--muted)"}}>Connect a wallet to claim.</p>
          ) : (
            <>
              <button onClick={handleClaim} disabled={isSubmitting || isMining || isMined}>
                {isMined ? "Claimed" : isMining ? "Confirming…" : isSubmitting ? "Submitting…" : "Claim"}
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
