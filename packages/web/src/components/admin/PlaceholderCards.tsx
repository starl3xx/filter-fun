"use client";

import type {Address} from "viem";

import {C, F} from "@/lib/tokens";

import {Card} from "./Card";

/// Placeholder cards for features that depend on other epics:
///   - Bag-lock (Epic 1.13 — audit-gated; contracts not yet shipped)
///   - Verify token (off-chain attestation flow — design pending)
///
/// They're rendered here rather than omitted entirely so creators can see
/// what's coming and so the layout doesn't shift when those features land.

export function BagLockPlaceholder() {
  return (
    <Card label="Bag-lock commitment">
      <div
        style={{
          padding: "10px 12px",
          borderRadius: 9,
          background: `${C.purple}10`,
          border: `1px dashed ${C.purple}55`,
          fontSize: 12,
          color: C.dim,
          fontFamily: F.display,
          lineHeight: 1.5,
        }}
      >
        <strong style={{color: C.purple}}>Coming soon — Epic 1.13.</strong>{" "}
        Opt-in time-lock on your own holdings. Once locked, the lock can be EXTENDED but
        never shortened — even by you, even by the protocol. The killer trust signal vs
        Clanker (spec §38.8). Audit-gated for mainnet activation.
      </div>
    </Card>
  );
}

export function VerifyPlaceholder() {
  return (
    <Card label="Verify token">
      <div
        style={{
          padding: "10px 12px",
          borderRadius: 9,
          background: `${C.cyan}10`,
          border: `1px dashed ${C.cyan}55`,
          fontSize: 12,
          color: C.dim,
          fontFamily: F.display,
          lineHeight: 1.5,
        }}
      >
        <strong style={{color: C.cyan}}>Coming soon.</strong>{" "}
        Off-chain attestation flow. A "verified" badge surfaces on the Arena leaderboard
        once the attestation is signed.
      </div>
    </Card>
  );
}

/// Bulk distribute → deep link to Disperse.app pre-populated with the token.
/// Disperse.app accepts `?token=0x…` to set the token; recipients are entered
/// manually on the Disperse side.
export function BulkDistributeCard({token}: {token: Address}) {
  const url = `https://disperse.app/?token=${token}`;
  return (
    <Card label="Bulk distribute">
      <p style={{margin: "0 0 10px", fontSize: 12, color: C.dim, fontFamily: F.display, lineHeight: 1.5}}>
        Send to many addresses in one tx via Disperse.app — pre-populated with this token.
      </p>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "block",
          textAlign: "center",
          padding: "10px 14px",
          borderRadius: 9,
          background: "rgba(255,255,255,0.04)",
          border: `1px solid ${C.line}`,
          color: C.text,
          textDecoration: "none",
          fontWeight: 700,
          fontSize: 13,
          fontFamily: F.display,
        }}
      >
        Open in Disperse.app ↗
      </a>
    </Card>
  );
}
