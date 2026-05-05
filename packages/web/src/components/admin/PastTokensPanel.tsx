"use client";

/// Past tokens by this creator — Epic 1.23 (admin console v2 closeout).
///
/// Left column under the identity header. Lists every token the connected
/// admin has ever launched, with status pill + season anchor. Each row links
/// to that token's admin console (`/token/<addr>/admin`).
///
/// Self-link suppression: the currently-viewed token is filtered out so the
/// list never includes the page you're already on. Empty list (after
/// suppression) shows a "first launch" hint.
///
/// Auth: only rendered when the caller is the connected admin of the
/// currently-viewed token. Off-state callers see a muted hint.
///
/// Data: pulls `/profile/:address?role=creator` via `usePastTokens`. The
/// indexer returns rows keyed by creator-of-record, sorted by launchedAt.

import Link from "next/link";
import type {Address} from "viem";

import {usePastTokens} from "@/hooks/token/usePastTokens";
import type {ProfileCreatedToken} from "@/lib/arena/api";
import {weekLabel} from "@/lib/arena/format";
import {C, F} from "@/lib/tokens";

import {Card} from "./Card";

import {ProfileCtaLink} from "@/components/profile/ProfileCtaLink";

export type PastTokensPanelProps = {
  /// The wallet whose past launches should render. Null when wagmi reports
  /// no connection — the panel renders a muted hint in that case.
  walletAddress: Address | null;
  /// Whether the caller is the admin of the current token. Drives the
  /// "_only visible to admin_" hint when false.
  isAdmin: boolean;
  /// The currently-viewed token. Filtered out of the list so the user
  /// never sees a self-link to the page they're already on.
  currentToken: Address;
};

export function PastTokensPanel({walletAddress, isAdmin, currentToken}: PastTokensPanelProps) {
  if (!isAdmin) {
    return (
      <Card label="Your launches">
        <p style={{margin: 0, fontSize: 12, color: C.faint, fontFamily: F.mono}}>
          <em>only visible to admin</em>
        </p>
      </Card>
    );
  }
  return <PastTokensPanelInner walletAddress={walletAddress} currentToken={currentToken} />;
}

function PastTokensPanelInner({
  walletAddress,
  currentToken,
}: {
  walletAddress: Address | null;
  currentToken: Address;
}) {
  const {data, error, isLoading} = usePastTokens(walletAddress);

  if (error) {
    return (
      <Card label="Your launches">
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
            We couldn't load your past launches. The next poll will retry automatically.
          </p>
        </div>
      </Card>
    );
  }

  if (isLoading || !data) {
    return (
      <Card label="Your launches">
        <div aria-hidden style={{display: "flex", flexDirection: "column", gap: 6}}>
          {[0, 1].map((i) => (
            <div
              key={i}
              className="ff-pulse"
              style={{
                height: 20,
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

  const others = data.createdTokens
    .filter((t) => t.token.toLowerCase() !== currentToken.toLowerCase())
    // Most-recent first. Indexer doesn't guarantee an order on the wire so we
    // pin it here against the launchedAt ISO string (lexicographic = chronological
    // for ISO 8601).
    .sort((a, b) => (a.launchedAt < b.launchedAt ? 1 : a.launchedAt > b.launchedAt ? -1 : 0));

  if (others.length === 0) {
    return (
      <Card label="Your launches">
        <p style={{margin: 0, fontSize: 13, color: C.dim, fontFamily: F.display}}>
          This is your first launch.
        </p>
      </Card>
    );
  }

  return (
    <Card label="Your launches">
      {/* Epic 1.24 — surface a CTA into the connected admin's profile.
          Sits above the list so it's discoverable without forcing it into
          the row layout. */}
      {walletAddress ? (
        <div style={{marginBottom: 8}}>
          <ProfileCtaLink address={walletAddress} label="View your profile →" />
        </div>
      ) : null}
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
        {others.map((t) => (
          <PastTokenRow key={t.token} token={t} />
        ))}
      </ul>
    </Card>
  );
}

function PastTokenRow({token}: {token: ProfileCreatedToken}) {
  const status = statusFor(token);
  return (
    <li>
      <Link
        href={`/token/${token.token}/admin`}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 8,
          padding: "4px 0",
          fontSize: 12,
          fontFamily: F.mono,
          textDecoration: "none",
          color: C.text,
        }}
      >
        <span style={{fontWeight: 700}}>{token.ticker}</span>
        <span style={{color: C.dim, flex: 1, marginLeft: 8}}>{weekLabel(token.seasonId)}</span>
        <span style={{color: status.color, fontSize: 11, fontWeight: 800, letterSpacing: "0.04em"}}>
          {status.label}
        </span>
      </Link>
    </li>
  );
}

/// Status pill rendering rules — mirrors the dispatch's example layout:
///
///   $ABC · Season 7 · WINNER · earning fees
///   $XYZ · Season 5 · FILTERED · ranked #N of 12
///   $DEF · Season 4 · NO ACTIVATION (refunded)
///
/// `rank` is included for FILTERED tokens when the indexer surfaced one;
/// pre-1.23 ranks for past-season filtered tokens may be 0 (the default
/// CreatedTokenRow.rank under the old query) → we render "FILTERED" only.
function statusFor(t: ProfileCreatedToken): {label: string; color: string} {
  if (t.status === "WEEKLY_WINNER") return {label: "WINNER · earning fees", color: C.yellow};
  if (t.status === "QUARTERLY_FINALIST") return {label: "QUARTERLY FINALIST", color: C.cyan};
  if (t.status === "QUARTERLY_CHAMPION") return {label: "QUARTERLY CHAMPION", color: C.yellow};
  if (t.status === "ANNUAL_FINALIST") return {label: "ANNUAL FINALIST", color: C.cyan};
  if (t.status === "ANNUAL_CHAMPION") return {label: "ANNUAL CHAMPION", color: C.yellow};
  if (t.status === "FILTERED") {
    if (t.rank > 0) {
      return {label: `FILTERED · ranked #${t.rank}`, color: C.faint};
    }
    return {label: "FILTERED", color: C.faint};
  }
  return {label: "ACTIVE", color: C.dim};
}
