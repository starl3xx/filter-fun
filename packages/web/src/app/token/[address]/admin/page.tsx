"use client";

/// /token/[address]/admin — per-token Creator Admin Console (Epic 1.11).
///
/// Three-column layout per spec §38.2: identity + claim (left), live
/// competitive status (center), metadata + admin actions (right). Mobile
/// collapses to a single column.
///
/// Auth model has 4 states (driven by `useAdminAuth`):
///   DISCONNECTED — read-only with "connect" CTAs on every action.
///   READ_ONLY    — connected but not the admin; same read-only treatment.
///   PENDING      — connected wallet was nominated; can ONLY accept admin.
///   ADMIN        — full control; all forms enabled.
///
/// Past-season tokens (this season's id < currentSeason) hide the live panels
/// — countdown, stake status, settlement preview — and show only static
/// outcome state. Today the admin console is wired to currentSeasonId only;
/// past-season detection is a v2 follow-up once we surface a per-token
/// `seasonId` from the indexer or registry view.
///
/// Epic 1.16 (spec §10.3 + §10.6, locked 2026-05-02): the ClaimFeesPanel works
/// for ANY token the wallet created, regardless of season — the underlying
/// `CreatorFeeDistributor.claim()` is no longer time- or filter-gated, so winning
/// creators of past tokens can navigate to `/token/<addr>/admin` and pull
/// long-tail accrual indefinitely. The "still earning" badge on the panel
/// reflects this; the only path that surfaces "disabled" is the multisig
/// emergency override (sanctioned/compromised recipient).

import {useEffect, useMemo, useRef, useState} from "react";
import {useParams} from "next/navigation";
import type {Address} from "viem";
import {isAddress} from "viem";
import {useConnect} from "wagmi";

import {AdminTransferForms} from "@/components/admin/AdminTransferForms";
import {AuthBanner} from "@/components/admin/AuthBanner";
import {BagLockCard} from "@/components/admin/BagLockCard";
import {BountyEstimate} from "@/components/admin/BountyEstimate";
import {ClaimFeesPanel} from "@/components/admin/ClaimFeesPanel";
import {HoldingsPanel} from "@/components/admin/HoldingsPanel";
import {HpPanel} from "@/components/admin/HpPanel";
import {MetadataForm} from "@/components/admin/MetadataForm";
import {PastTokensPanel} from "@/components/admin/PastTokensPanel";
import {PhaseCountdown} from "@/components/admin/PhaseCountdown";
import {BulkDistributeCard, VerifyPlaceholder} from "@/components/admin/PlaceholderCards";
import {RankPanel} from "@/components/admin/RankPanel";
import {RecipientForm} from "@/components/admin/RecipientForm";
import {SettlementPreview} from "@/components/admin/SettlementPreview";
import {StakeStatusPanel} from "@/components/admin/StakeStatusPanel";
import {SurvivalActions} from "@/components/admin/SurvivalActions";
import {TokenHeader} from "@/components/admin/TokenHeader";
import {Card} from "@/components/admin/Card";
import {TopBar} from "@/components/broadcast/TopBar";
import {useSeason} from "@/hooks/arena/useSeason";
import {useTokens} from "@/hooks/arena/useTokens";
import {useAdminAuth} from "@/hooks/token/useAdminAuth";
import {useSeasonContext} from "@/hooks/token/useSeasonContext";
import {useStakeStatus} from "@/hooks/token/useStakeStatus";
import {useTokenAdmin} from "@/hooks/token/useTokenAdmin";
import {useTokenStats} from "@/hooks/token/useTokenStats";
import {C, F} from "@/lib/tokens";

export default function AdminConsolePage() {
  const params = useParams<{address: string}>();
  const raw = params?.address ?? "";
  const valid = isAddress(raw);
  const tokenAddress = valid ? (raw as Address) : null;

  if (!tokenAddress) return <InvalidAddress raw={raw} />;
  return <AdminConsole token={tokenAddress} />;
}

function AdminConsole({token}: {token: Address}) {
  const {info, isLoading: adminLoading, error: adminError} = useTokenAdmin(token);
  const auth = useAdminAuth(info);
  const {data: season, error: seasonError} = useSeason();
  const {data: tokens, error: tokensError} = useTokens();
  const {context} = useSeasonContext();
  const {stats, isLoading: statsLoading} = useTokenStats(token);
  const {status: stakeStatus, error: stakeError} = useStakeStatus(token, context.seasonId);
  const {connect, connectors} = useConnect();

  // Phase 1 audit C-7 (Phase 1 audit 2026-05-01): the four data hooks above
  // each return null/undefined on RPC failure, which previously left the
  // center column rendering an empty/broken state with no signal that
  // anything went wrong. Coalesce the errors and render a single error card
  // in the center column so the user sees what's failing and can retry.
  // adminError + stakeError signal RPC reads (the wagmi multi-read pipeline);
  // seasonError + tokensError signal indexer-poll fetch failures. Either
  // class blanks the same UI panels — center column is where users look for
  // live state, so that's where the error chip lives.
  const liveDataError = adminError ?? stakeError ?? seasonError ?? tokensError ?? null;

  const acceptAnchorRef = useRef<HTMLDivElement | null>(null);

  // Audit H-Web-5 (Phase 1, 2026-05-01): auto-scroll the accept form into view
  // when the admin console mounts (or transitions) into PENDING state. Pre-fix
  // `onScrollToAccept` only fired on user click of the auth-banner CTA — if
  // the user landed on the page with auth.state already PENDING (the typical
  // path: nominator shares the URL via DM), they had to hunt the right column
  // for the form. Pulse the border for ~2s on the same trigger so the visual
  // anchor matches the scroll target.
  const [scrollPulse, setScrollPulse] = useState(false);
  useEffect(() => {
    if (auth.state !== "PENDING") return;
    if (acceptAnchorRef.current) {
      acceptAnchorRef.current.scrollIntoView({behavior: "smooth", block: "center"});
    }
    setScrollPulse(true);
    const t = setTimeout(() => setScrollPulse(false), 2000);
    return () => clearTimeout(t);
  }, [auth.state]);

  const chain = (process.env.NEXT_PUBLIC_CHAIN === "base" ? "base" : "base-sepolia") as
    | "base"
    | "base-sepolia";

  const cohort = useMemo(() => tokens ?? [], [tokens]);
  const tokenStats = stats.token;
  const ticker = tokenStats?.ticker ?? "$…";
  // Pull this token's bag-lock surface off the cohort. `null` while /tokens is
  // still resolving or when the token isn't in the current cohort (past-season
  // tokens). The card handles `null` as "no commitment recorded" — same shape
  // the indexer would have surfaced if the row existed without a lock.
  const bagLock = useMemo(() => {
    const row = cohort.find((t) => t.token.toLowerCase() === token.toLowerCase());
    return row?.bagLock ?? null;
  }, [cohort, token]);

  const canEdit = auth.state === "ADMIN";
  const isWinner = stats.token?.rank === 1;
  const isPastSeason = season?.phase === "settled";

  function onConnect() {
    const injected = connectors.find((c) => c.type === "injected");
    if (injected) connect({connector: injected});
  }

  function onScrollToAccept() {
    acceptAnchorRef.current?.scrollIntoView({behavior: "smooth", block: "center"});
  }

  return (
    <div style={{minHeight: "100vh"}}>
      <TopBar />
      <main className="ff-grid" style={{paddingTop: 16}}>
        <div style={{gridColumn: "1 / -1"}}>
          <h1
            style={{
              margin: "0 0 4px",
              fontSize: 22,
              fontWeight: 800,
              fontFamily: F.display,
              letterSpacing: "-0.02em",
              color: C.text,
            }}
          >
            Creator console
          </h1>
          <p
            style={{
              margin: "0 0 12px",
              fontSize: 13,
              color: C.dim,
              fontFamily: F.display,
            }}
          >
            Manage <strong style={{color: C.text}}>{ticker}</strong> · Watch your HP, claim your fees,
            update on-chain settings.
          </p>
          <AuthBanner
            state={auth.state}
            admin={info.admin}
            pendingAdmin={info.pendingAdmin}
            onConnect={auth.state === "DISCONNECTED" ? onConnect : undefined}
            onScrollToAccept={auth.state === "PENDING" ? onScrollToAccept : undefined}
          />
        </div>

        {/* LEFT — identity + claim */}
        <div
          className="ff-col-left"
          style={{display: "flex", flexDirection: "column", gap: 0, minWidth: 0}}
        >
          <TokenHeader
            ticker={ticker}
            address={token}
            chain={chain}
            isAdmin={auth.state === "ADMIN"}
          />
          <ClaimFeesPanel
            token={token}
            creator={info.creator}
            recipient={info.recipient}
            auth={auth}
          />
          <PastTokensPanel
            walletAddress={auth.connected}
            isAdmin={auth.state === "ADMIN"}
            currentToken={token}
          />
          {adminLoading && info.creator === null && (
            <Card label="Loading">
              <p style={{margin: 0, fontSize: 12, color: C.faint, fontFamily: F.mono}}>
                Resolving on-chain state…
              </p>
            </Card>
          )}
        </div>

        {/* CENTER — live competitive status */}
        <div
          className="ff-col-center"
          style={{display: "flex", flexDirection: "column", gap: 0, minWidth: 0}}
        >
          {liveDataError && <LiveDataErrorCard error={liveDataError} />}
          {tokenStats ? (
            <>
              <HpPanel token={tokenStats} />
              <RankPanel stats={stats} />
              {!isPastSeason && <PhaseCountdown season={season ?? null} />}
              {!isPastSeason && stakeStatus.state !== "UNKNOWN" && (
                <StakeStatusPanel status={stakeStatus} />
              )}
              {!isPastSeason && (
                <BountyEstimate season={season ?? null} isWinner={isWinner} />
              )}
              {!isPastSeason && season?.phase === "finals" && (
                <SettlementPreview stats={stats} cohort={cohort} season={season ?? null} />
              )}
              <SurvivalActions token={tokenStats} />
            </>
          ) : statsLoading ? (
            // Audit M-Ux-7 (Phase 1, 2026-05-03): pre-fix the center column
            // showed "This token isn't in the current season's cohort" the
            // moment the page mounted, BEFORE the /tokens fetch resolved —
            // so a creator landing on their own admin console saw a
            // false-negative "not in cohort" message during the (~1s)
            // loading window. Distinguishing the two states by checking
            // `statsLoading` lets us render skeleton cards instead. The
            // skeleton matches the visual rhythm of the real panels (HP
            // bar + rank chip + countdown clock + stake panel) so the
            // loading-to-loaded transition doesn't shift the layout.
            <SkeletonStack />
          ) : (
            <Card label="Token">
              <p style={{margin: 0, fontSize: 13, color: C.dim, fontFamily: F.display}}>
                This token isn't in the current season's cohort. Live HP / rank panels are
                hidden until it appears in <code style={{fontFamily: F.mono}}>/tokens</code>.
              </p>
            </Card>
          )}
        </div>

        {/* RIGHT — metadata + admin actions */}
        <div
          className="ff-col-right"
          style={{display: "flex", flexDirection: "column", gap: 0, minWidth: 0}}
        >
          <MetadataForm token={token} currentUri={info.metadataURI} canEdit={canEdit} />
          <RecipientForm token={token} currentRecipient={info.recipient} canEdit={canEdit} />
          <HoldingsPanel walletAddress={auth.connected} isAdmin={auth.state === "ADMIN"} />
          <AdminTransferForms
            ref={acceptAnchorRef}
            token={token}
            currentAdmin={info.admin}
            pendingAdmin={info.pendingAdmin}
            authState={auth.state}
            pulseAccept={scrollPulse && auth.state === "PENDING"}
          />
          <BagLockCard
            token={token}
            creator={info.creator}
            bagLock={bagLock}
            chain={chain}
          />
          <VerifyPlaceholder />
          <BulkDistributeCard token={token} />
        </div>
      </main>
    </div>
  );
}

/// Audit C-7 (Phase 1 audit 2026-05-01) error card for the admin console's
/// center column. Renders ABOVE the live panels so it appears whether the
/// hook returned partial data (chip + degraded panels) or no data
/// (chip + empty state). Uses the same red accent + ▼ glyph as the other
/// failure surfaces. The polling hooks reset `error` on the next successful
/// fetch — no manual retry control is provided because the next poll is the
/// retry, and adding one would risk masking a recurring failure.
function LiveDataErrorCard({error}: {error: Error}) {
  return (
    <Card label="Live data error">
      <div
        role="alert"
        aria-live="polite"
        style={{display: "flex", flexDirection: "column", gap: 6}}
      >
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
          We couldn't load on-chain or indexer state for this token. Live HP, rank, stake, and
          settlement panels below may be stale or empty until the next poll succeeds.
        </p>
        <code
          style={{
            fontFamily: F.mono,
            fontSize: 11,
            color: C.faint,
            wordBreak: "break-all",
          }}
        >
          {error.message}
        </code>
      </div>
    </Card>
  );
}

/// Audit M-Ux-7: skeleton placeholder rendered in the center column
/// while `useTokenStats` is still resolving. Four cards mirroring the
/// shape of HpPanel + RankPanel + PhaseCountdown + StakeStatusPanel so
/// the layout doesn't shift when the data lands. Pulses via the
/// existing `ff-pulse` keyframe so the skeleton reads as "loading,"
/// not "broken." Aria-hidden because the loading state is purely
/// visual — screen readers get the rendered cards once they appear.
function SkeletonStack() {
  return (
    <div aria-hidden style={{display: "flex", flexDirection: "column", gap: 12}}>
      {[80, 56, 56, 72].map((h, i) => (
        <div
          key={i}
          className="ff-pulse"
          style={{
            height: h,
            borderRadius: 10,
            background: "rgba(255,255,255,0.04)",
            border: `1px solid ${C.line}`,
          }}
        />
      ))}
    </div>
  );
}

function InvalidAddress({raw}: {raw: string}) {
  return (
    <div style={{minHeight: "100vh"}}>
      <TopBar />
      <main style={{padding: 32, maxWidth: 720, margin: "0 auto"}}>
        <h1 style={{fontFamily: F.display, fontSize: 22, fontWeight: 800, marginBottom: 8}}>
          Invalid token address
        </h1>
        <p style={{fontFamily: F.display, color: C.dim}}>
          <code style={{fontFamily: F.mono}}>{raw || "(empty)"}</code> isn't a valid 0x-prefixed address.
          The admin console route is <code style={{fontFamily: F.mono}}>/token/[address]/admin</code> — pass a
          checksummed Ethereum address as the segment.
        </p>
      </main>
    </div>
  );
}
