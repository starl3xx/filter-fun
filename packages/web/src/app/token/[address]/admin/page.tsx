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

import {useMemo, useRef} from "react";
import {useParams} from "next/navigation";
import type {Address} from "viem";
import {isAddress} from "viem";
import {useConnect} from "wagmi";

import {AdminTransferForms} from "@/components/admin/AdminTransferForms";
import {AuthBanner} from "@/components/admin/AuthBanner";
import {BountyEstimate} from "@/components/admin/BountyEstimate";
import {ClaimFeesPanel} from "@/components/admin/ClaimFeesPanel";
import {HpPanel} from "@/components/admin/HpPanel";
import {MetadataForm} from "@/components/admin/MetadataForm";
import {PhaseCountdown} from "@/components/admin/PhaseCountdown";
import {
  BagLockPlaceholder,
  BulkDistributeCard,
  VerifyPlaceholder,
} from "@/components/admin/PlaceholderCards";
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
import {useCreatorFees} from "@/hooks/token/useCreatorFees";
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
  const {info, isLoading: adminLoading} = useTokenAdmin(token);
  const auth = useAdminAuth(info);
  const {data: season} = useSeason();
  const {data: tokens} = useTokens();
  const {context} = useSeasonContext();
  const {stats} = useTokenStats(token);
  const {status: stakeStatus} = useStakeStatus(token, context.seasonId);
  const fees = useCreatorFees(token);
  const {connect, connectors} = useConnect();

  const acceptAnchorRef = useRef<HTMLDivElement | null>(null);

  const chain = (process.env.NEXT_PUBLIC_CHAIN === "base" ? "base" : "base-sepolia") as
    | "base"
    | "base-sepolia";

  const cohort = useMemo(() => tokens ?? [], [tokens]);
  const tokenStats = stats.token;
  const ticker = tokenStats?.ticker ?? "$…";

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
          ref={acceptAnchorRef}
        >
          <MetadataForm token={token} currentUri={info.metadataURI} canEdit={canEdit} />
          <RecipientForm token={token} currentRecipient={info.recipient} canEdit={canEdit} />
          <AdminTransferForms
            token={token}
            currentAdmin={info.admin}
            pendingAdmin={info.pendingAdmin}
            authState={auth.state}
          />
          <BagLockPlaceholder />
          <VerifyPlaceholder />
          <BulkDistributeCard token={token} />
        </div>
      </main>
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
