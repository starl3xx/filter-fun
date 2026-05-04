"use client";

/// Creator's own holdings panel — Epic 1.23 (admin console v2 closeout).
///
/// Right column under the recipient form. Renders the connected admin's
/// per-token holdings + projected rollover entitlement. Admin-gated: shown
/// to ADMIN-state callers only; READ_ONLY / DISCONNECTED / PENDING get a
/// muted "_only visible to admin_" hint.
///
/// State machine (4 cases, all covered by the panel-states test):
///   no-wallet       — rendered only when admin is logged-in; otherwise the
///                     panel is hidden via the auth gate at the call site.
///   not-admin       — auth.state !== "ADMIN" → render the hint.
///   no-holdings     — fetch resolved with `tokens: []` → empty state copy.
///   loading         — skeleton rows.
///   loaded          — list of compact rows with status badge + projection.
///   error           — failure card with the same red-accent treatment as
///                     the other admin-console error surfaces.

import type {Address} from "viem";

import {useHoldings} from "@/hooks/token/useHoldings";
import type {HoldingsTokenRow} from "@/lib/arena/api";
import {C, F} from "@/lib/tokens";

import {Card} from "./Card";

export type HoldingsPanelProps = {
  /// The wallet whose holdings should render. Null until wagmi reports
  /// connection; the panel handles this without firing a request.
  walletAddress: Address | null;
  /// Whether the caller is the admin of the current token. Drives the
  /// "_only visible to admin_" hint.
  isAdmin: boolean;
};

export function HoldingsPanel({walletAddress, isAdmin}: HoldingsPanelProps) {
  if (!isAdmin) {
    return (
      <Card label="Your holdings">
        <p style={{margin: 0, fontSize: 12, color: C.faint, fontFamily: F.mono}}>
          <em>only visible to admin</em>
        </p>
      </Card>
    );
  }
  return <HoldingsPanelInner walletAddress={walletAddress} />;
}

function HoldingsPanelInner({walletAddress}: {walletAddress: Address | null}) {
  const {data, error, isLoading} = useHoldings(walletAddress);

  if (error) {
    return (
      <Card label="Your holdings">
        <div role="alert" aria-live="polite" style={{display: "flex", flexDirection: "column", gap: 6}}>
          <div
            style={{
              color: C.red,
              fontFamily: F.mono,
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            ▼ Read failed
          </div>
          <p style={{margin: 0, fontSize: 13, color: C.dim, fontFamily: F.display, lineHeight: 1.5}}>
            We couldn't load your holdings. The next poll will retry automatically.
          </p>
        </div>
      </Card>
    );
  }

  if (isLoading || !data) {
    return (
      <Card label="Your holdings">
        <div aria-hidden style={{display: "flex", flexDirection: "column", gap: 6}}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="ff-pulse"
              style={{
                height: 22,
                borderRadius: 6,
                background: "rgba(255,255,255,0.04)",
                border: `1px solid ${C.line}`,
              }}
            />
          ))}
        </div>
      </Card>
    );
  }

  if (data.tokens.length === 0) {
    return (
      <Card label="Your holdings">
        <p style={{margin: 0, fontSize: 13, color: C.dim, fontFamily: F.display}}>
          You don't hold any filter.fun tokens.
        </p>
      </Card>
    );
  }

  return (
    <Card label="Your holdings">
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {data.tokens.map((t) => (
          <HoldingRow key={t.address} token={t} />
        ))}
      </ul>
      {data.totalProjectedWeth !== "0" && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: `1px solid ${C.line}`,
            display: "flex",
            justifyContent: "space-between",
            fontSize: 12,
            fontFamily: F.mono,
            fontWeight: 700,
            color: C.text,
          }}
        >
          <span style={{color: C.dim}}>Total projected rollover</span>
          <span style={{color: C.cyan}}>{data.totalProjectedWethFormatted} ETH</span>
        </div>
      )}
    </Card>
  );
}

function HoldingRow({token}: {token: HoldingsTokenRow}) {
  const status = statusFor(token);
  return (
    <li
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 8,
        fontSize: 12,
        fontFamily: F.mono,
        padding: "4px 0",
      }}
    >
      <span style={{color: C.text, fontWeight: 700}}>{token.ticker}</span>
      <span style={{color: C.dim, flex: 1, marginLeft: 8}}>
        {token.balanceFormatted} tokens
      </span>
      <span style={{color: status.color, fontSize: 11, fontWeight: 800, letterSpacing: "0.04em"}}>
        {status.label}
      </span>
    </li>
  );
}

/// Per-row status string + color. Keeps the labelling in one place so the
/// panel reads consistently; consumers don't have to think about which flag
/// to render.
///
/// Bugbot PR #101 (Low): finalist tokens (`isFinalist: true, isFiltered: false,
/// isWinner: false`) used to fall through to the default "pre-cut" copy — a
/// finalist literally survived the cut, so labelling it "pre-cut" misled the
/// creator. Surface a "finalist · pre-settlement" label for this state.
function statusFor(t: HoldingsTokenRow): {label: string; color: string} {
  if (t.isWinner) return {label: "winner (no rollover)", color: C.yellow};
  if (t.postSettlement && t.isFiltered) {
    return {label: "claim available", color: C.cyan};
  }
  if (t.isFiltered) {
    if (t.projectedRolloverWethFormatted !== null) {
      return {
        label: `projected rollover: ${t.projectedRolloverWethFormatted} ETH (filtered)`,
        color: C.cyan,
      };
    }
    return {label: "filtered (no entitlement)", color: C.faint};
  }
  if (t.isFinalist) {
    return {label: "finalist · pre-settlement", color: C.dim};
  }
  return {label: "pre-cut · projection N/A", color: C.faint};
}
