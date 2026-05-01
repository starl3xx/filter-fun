"use client";

import {useState} from "react";
import type {Address} from "viem";

import {C, F} from "@/lib/tokens";

import {Card} from "./Card";

/// Identity header for a token: name + ticker + address with copy + chain
/// badge + an "Admin" pill when the connected wallet matches.

export type TokenHeaderProps = {
  ticker: string;
  address: Address;
  chain: "base" | "base-sepolia";
  /// Show the "Admin" badge — only true when the connected wallet is the
  /// current admin (drives a one-pixel UI affordance, not auth).
  isAdmin: boolean;
};

export function TokenHeader({ticker, address, chain, isAdmin}: TokenHeaderProps) {
  const [copied, setCopied] = useState(false);

  function copyAddress() {
    navigator.clipboard.writeText(address).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {
        // Clipboard API can fail in secure-context-less environments. Silent
        // fallback — the user can still select the address manually.
      },
    );
  }

  return (
    <Card label="Token">
      <div style={{display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap"}}>
        <span
          style={{
            fontSize: 20,
            fontWeight: 800,
            fontFamily: F.display,
            color: C.text,
            letterSpacing: "-0.02em",
          }}
        >
          {ticker}
        </span>
        <span
          aria-label={`Chain ${chain}`}
          style={{
            padding: "3px 7px",
            borderRadius: 99,
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            fontFamily: F.mono,
            background: `${C.cyan}1a`,
            border: `1px solid ${C.cyan}55`,
            color: C.cyan,
          }}
        >
          {chain === "base" ? "Base · V4" : "Base Sepolia · V4"}
        </span>
        {isAdmin && (
          <span
            data-admin-badge="active"
            style={{
              padding: "3px 7px",
              borderRadius: 99,
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              fontFamily: F.mono,
              background: `linear-gradient(135deg, ${C.pink}, ${C.purple})`,
              color: "#fff",
              boxShadow: `0 2px 10px ${C.pink}55`,
            }}
          >
            Admin
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={copyAddress}
        style={{
          marginTop: 8,
          background: "transparent",
          border: `1px dashed ${C.line}`,
          borderRadius: 8,
          padding: "6px 9px",
          color: C.dim,
          fontFamily: F.mono,
          fontSize: 11,
          cursor: "pointer",
          width: "100%",
          textAlign: "left",
        }}
        title="Copy address"
      >
        {copied ? "Copied ✓" : address}
      </button>
    </Card>
  );
}
