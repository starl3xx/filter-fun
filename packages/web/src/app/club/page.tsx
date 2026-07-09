"use client";

/// `/club` — Filter Club founding-member mint (Epic 2.6 / spec §47.3.8).
///
/// Composition:
///
///   ┌──────────────────────────────────────────────────────────────┐
///   │ ← arena · Header (▼ FILTER CLUB · founding members)          │
///   ├──────────────────────────────────────┬───────────────────────┤
///   │ SupplyProgress (minted/max bar)      │ MintBox               │
///   │ UtilityCopy (2 free launches, …)     │  (stepper + total +   │
///   │ RosterSection (GET /club)            │   mint button)        │
///   └──────────────────────────────────────┴───────────────────────┘
///
/// The 250-NFT pre-launch raise from the one-pager: 2 lifetime free launches
/// per pass, bounded utility, public roster. Supply/price/caps read on-chain
/// (8s cadence, mirroring useLaunchSlots); the roster + credit accounting
/// come from the indexer's public `GET /club`. Sold-out, paused,
/// wallet-not-connected, and pass-not-deployed each render their own state —
/// never a dead button without a reason.

import {useEffect, useState} from "react";
import Link from "next/link";
import {useAccount} from "wagmi";

import {Stars} from "@/components/Stars";
import {Triangle} from "@/components/Triangle";
import {useClubSupply} from "@/hooks/club/useClubSupply";
import {useMintPass, type MintPhase} from "@/hooks/club/useMintPass";
import {isDeployed} from "@/lib/addresses";
import {fetchClub, type ClubResponse} from "@/lib/arena/api";
import {clampMintQty, maxMintable, type MintBounds} from "@/lib/club/mint";
import {fmtEthFromWei, shortAddr} from "@/lib/launch/format";
import {fmtUsd, weiToUsd} from "@/lib/launch/economics";
import {C, F} from "@/lib/tokens";

/// Audit-budget target the mint proceeds work toward (250 × 0.05 ETH — the
/// one-pager's raise math). Mirrored in the operator FilterClubCard; display
/// framing only, never used in tx math.
const AUDIT_BUDGET_ETH = 12.5;

type ClubFetchState =
  | {state: "loading"}
  | {state: "ready"; data: ClubResponse}
  | {state: "error"; message: string};

export default function ClubPage() {
  const {isConnected} = useAccount();
  const supply = useClubSupply();
  const mintFlow = useMintPass();

  const [club, setClub] = useState<ClubFetchState>({state: "loading"});
  useEffect(() => {
    let cancelled = false;
    fetchClub()
      .then((r) => {
        if (!cancelled) setClub({state: "ready", data: r});
      })
      .catch((err) => {
        if (cancelled) return;
        setClub({state: "error", message: err instanceof Error ? err.message : "Failed to load"});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const deployed = isDeployed("filterClubPass");

  return (
    <div style={{position: "relative", minHeight: "100vh", overflow: "hidden"}}>
      <Stars />
      <main
        style={{
          position: "relative",
          zIndex: 1,
          maxWidth: 1100,
          margin: "0 auto",
          padding: "32px 24px 64px",
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        <Link
          href="/"
          style={{fontSize: 12, color: C.dim, textDecoration: "none", fontFamily: F.mono}}
        >
          ← arena
        </Link>
        <Header />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 20,
            alignItems: "start",
          }}
        >
          <div style={{display: "flex", flexDirection: "column", gap: 20, minWidth: 0}}>
            <SupplyProgress supply={supply.data} deployed={deployed} />
            <UtilityCopy />
            <RosterSection club={club} />
          </div>
          <div style={{minWidth: 0}}>
            {deployed ? (
              <MintBox
                supply={supply.data}
                connected={isConnected}
                phase={mintFlow.phase}
                error={mintFlow.error}
                mintedTokenIds={mintFlow.mintedTokenIds}
                onMint={(qty, valueWei) => mintFlow.mint({qty, valueWei})}
                onReset={mintFlow.reset}
              />
            ) : (
              <NotDeployedCard />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function Header() {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 4}}>
      <div
        style={{
          fontSize: 12,
          color: C.pink,
          fontFamily: F.mono,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Triangle size={12} inline /> Filter Club
      </div>
      <div
        style={{
          fontSize: 32,
          fontFamily: F.display,
          fontWeight: 800,
          color: C.text,
          letterSpacing: "-0.02em",
        }}
      >
        Founding members
      </div>
      <div style={{fontSize: 13, color: C.dim, maxWidth: 600}}>
        250-pass pre-launch raise. 2 lifetime free launches per pass, bounded utility, public
        roster. Proceeds fund the security audit + treasury seed + ops.
      </div>
    </div>
  );
}

// ============================================================ supply progress

function SupplyProgress({
  supply,
  deployed,
}: {
  supply: ReturnType<typeof useClubSupply>["data"];
  deployed: boolean;
}) {
  const minted = supply ? Number(supply.totalMinted) : null;
  const max = supply ? Number(supply.maxSupply) : null;
  const soldOut = supply !== null && supply.totalMinted >= supply.maxSupply;
  const pct = minted !== null && max !== null && max > 0 ? Math.min(100, (minted / max) * 100) : 0;

  return (
    <section
      data-testid="club-supply"
      style={{
        padding: 16,
        borderRadius: 14,
        border: `1px solid ${C.line}`,
        background: "rgba(255,255,255,0.03)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8}}>
        <span
          style={{
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: 10,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: C.cyan,
          }}
        >
          Mint progress
        </span>
        {soldOut ? (
          <span
            data-testid="club-sold-out"
            style={{
              padding: "2px 8px",
              borderRadius: 99,
              border: `1px solid ${C.yellow}66`,
              background: `${C.yellow}1a`,
              color: C.yellow,
              fontFamily: F.mono,
              fontWeight: 800,
              fontSize: 9,
              letterSpacing: "0.16em",
            }}
          >
            SOLD OUT
          </span>
        ) : (
          <span style={{fontFamily: F.mono, fontSize: 13, fontWeight: 800, color: C.text, fontVariantNumeric: "tabular-nums"}}>
            {/* M-Ux-4 discipline: dashes while loading, never a lying 0/0. */}
            {minted !== null && max !== null ? `${minted} / ${max}` : "— / —"}
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max ?? 0}
        aria-valuenow={minted ?? 0}
        aria-label="Passes minted"
        style={{
          height: 10,
          borderRadius: 99,
          background: "rgba(255,255,255,0.06)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            borderRadius: 99,
            background: soldOut
              ? `linear-gradient(90deg, ${C.yellow}, ${C.pink})`
              : `linear-gradient(90deg, ${C.pink}, ${C.purple})`,
            transition: "width 400ms ease",
          }}
        />
      </div>
      {!deployed && (
        <p style={{margin: 0, fontSize: 11, color: C.faint, fontFamily: F.mono}}>
          Pass contract not deployed in this environment.
        </p>
      )}
    </section>
  );
}

// ============================================================ mint box

function MintBox({
  supply,
  connected,
  phase,
  error,
  mintedTokenIds,
  onMint,
  onReset,
}: {
  supply: ReturnType<typeof useClubSupply>["data"];
  connected: boolean;
  phase: MintPhase;
  error: string | null;
  mintedTokenIds: bigint[];
  onMint: (qty: bigint, valueWei: bigint) => void;
  onReset: () => void;
}) {
  const [requestedQty, setRequestedQty] = useState<bigint>(1n);

  const bounds: MintBounds | null = supply
    ? {
        totalMinted: supply.totalMinted,
        maxSupply: supply.maxSupply,
        walletMintCap: supply.walletMintCap,
        mintedByWallet: supply.mintedByWallet,
      }
    : null;
  // Derive the effective quantity at render time rather than clamping state
  // in an effect — a refetch that shrinks the bounds (someone else minted)
  // instantly corrects the stepper with no stale-frame window.
  const max = bounds ? maxMintable(bounds) : 0n;
  const qty = bounds ? clampMintQty(requestedQty, bounds) : 0n;

  const soldOut = supply !== null && supply.totalMinted >= supply.maxSupply;
  const walletCapped = supply !== null && !soldOut && max === 0n;
  const paused = supply?.paused === true;
  const totalWei = supply !== null && qty > 0n ? supply.mintPriceWei * qty : null;

  const busy = phase === "signing" || phase === "broadcasting";
  const mintDisabled =
    !connected || supply === null || soldOut || paused || qty === 0n || busy || phase === "success";

  return (
    <form
      data-testid="club-mint-box"
      onSubmit={(e) => {
        e.preventDefault();
        if (mintDisabled || totalWei === null) return;
        onMint(qty, totalWei);
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        padding: 18,
        borderRadius: 14,
        border: `1px solid ${C.line}`,
        background: "rgba(255,255,255,0.03)",
      }}
    >
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
        <h2
          style={{
            margin: 0,
            fontFamily: F.display,
            fontWeight: 800,
            fontSize: 15,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span aria-hidden>🎟️</span> Mint a pass
        </h2>
        <span
          style={{
            padding: "2px 8px",
            borderRadius: 99,
            border: `1px solid ${C.pink}55`,
            background: `${C.pink}1a`,
            color: C.pink,
            fontFamily: F.mono,
            fontWeight: 800,
            fontSize: 9,
            letterSpacing: "0.16em",
          }}
        >
          {supply !== null ? `${fmtEthFromWei(supply.mintPriceWei)} EACH` : "Ξ — EACH"}
        </span>
      </div>

      {/* Quantity stepper — bounds mirror the contract's two caps so the
          stepper can never offer a quantity the chain would revert. */}
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10}}>
        <span
          style={{
            fontSize: 9,
            fontFamily: F.mono,
            color: C.faint,
            letterSpacing: "0.16em",
            fontWeight: 700,
            textTransform: "uppercase",
          }}
        >
          Quantity
        </span>
        <div style={{display: "inline-flex", alignItems: "center", gap: 10}}>
          <StepButton
            label="−"
            testId="club-qty-dec"
            disabled={qty <= 1n || busy}
            onClick={() => setRequestedQty(qty - 1n)}
          />
          <span
            data-testid="club-qty"
            style={{
              fontFamily: F.mono,
              fontWeight: 800,
              fontSize: 18,
              color: C.text,
              minWidth: 28,
              textAlign: "center",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {qty.toString()}
          </span>
          <StepButton
            label="+"
            testId="club-qty-inc"
            disabled={qty >= max || busy}
            onClick={() => setRequestedQty(qty + 1n)}
          />
        </div>
      </div>
      {supply !== null && max > 0n && (
        <p style={{margin: 0, fontSize: 10, color: C.faint, fontFamily: F.mono, textAlign: "right"}}>
          max {max.toString()} for this wallet
        </p>
      )}

      <div style={{height: 1, background: C.line}} />
      <div style={{display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8}}>
        <span style={{fontSize: 11, color: C.text, fontWeight: 800, fontFamily: F.mono, letterSpacing: "0.04em"}}>
          Total
        </span>
        <span style={{display: "inline-flex", alignItems: "baseline", gap: 8, fontFamily: F.mono, fontVariantNumeric: "tabular-nums"}}>
          <span style={{fontWeight: 800, fontSize: 16, color: C.text}}>
            {totalWei !== null ? fmtEthFromWei(totalWei) : "Ξ —"}
          </span>
          <span style={{fontSize: 12, color: C.faint, fontWeight: 600}}>
            {totalWei !== null ? fmtUsd(weiToUsd(totalWei)) : "—"}
          </span>
        </span>
      </div>

      <button
        type="submit"
        data-testid="club-mint-submit"
        disabled={mintDisabled}
        style={{
          background: mintDisabled
            ? "rgba(255,255,255,0.06)"
            : "linear-gradient(135deg, #ff3aa1, #9c5cff)",
          color: mintDisabled ? C.faint : "#fff",
          border: "none",
          padding: "14px 16px",
          borderRadius: 10,
          fontWeight: 800,
          fontSize: 14,
          cursor: mintDisabled ? "not-allowed" : "pointer",
          letterSpacing: "0.04em",
          boxShadow: mintDisabled ? "none" : "0 8px 24px rgba(255, 58, 161, 0.4)",
        }}
      >
        {mintButtonCopy({phase, connected, supplyLoaded: supply !== null, soldOut, paused, walletCapped, qty})}
      </button>

      {phase === "success" && (
        <div
          data-testid="club-mint-success"
          role="status"
          aria-live="polite"
          style={{
            padding: 12,
            borderRadius: 10,
            border: `1px solid ${C.green}55`,
            background: `${C.green}10`,
            color: C.green,
            fontSize: 12,
            lineHeight: 1.5,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <span>{mintedCopy(mintedTokenIds)}</span>
          <span style={{color: C.dim}}>
            Your free-launch credits are live — the toggle appears on{" "}
            <Link href="/launch" style={{color: C.cyan}}>
              /launch
            </Link>
            .
          </span>
          {max > 0n && (
            <button
              type="button"
              onClick={onReset}
              style={{
                alignSelf: "flex-start",
                background: "transparent",
                border: `1px solid ${C.line}`,
                color: C.dim,
                padding: "4px 10px",
                borderRadius: 6,
                fontFamily: F.mono,
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              Mint another
            </button>
          )}
        </div>
      )}

      {error && (
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: 10,
            borderRadius: 8,
            border: `1px solid ${C.red}55`,
            background: `${C.red}10`,
            color: C.red,
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          {error}
        </div>
      )}

      {paused && (
        <p style={{margin: 0, fontSize: 11, color: C.yellow, fontFamily: F.mono}}>
          Minting is paused by the operator.
        </p>
      )}
    </form>
  );
}

function mintButtonCopy({
  phase,
  connected,
  supplyLoaded,
  soldOut,
  paused,
  walletCapped,
  qty,
}: {
  phase: MintPhase;
  connected: boolean;
  supplyLoaded: boolean;
  soldOut: boolean;
  paused: boolean;
  walletCapped: boolean;
  qty: bigint;
}): string {
  if (!connected) return "Connect wallet to mint";
  if (!supplyLoaded) return "Reading mint state…";
  if (soldOut) return "Sold out";
  if (paused) return "Minting paused";
  if (walletCapped) return "Wallet cap reached";
  switch (phase) {
    case "signing":
      return "Sign transaction in wallet…";
    case "broadcasting":
      return "Minting…";
    case "success":
      return "Minted ▼";
    default:
      return qty > 1n ? `Mint ${qty.toString()} passes →` : "Mint pass →";
  }
}

function mintedCopy(ids: bigint[]): string {
  if (ids.length === 0) return "Minted — welcome to the club.";
  if (ids.length === 1) return `Pass #${ids[0]!.toString()} minted — welcome to the club.`;
  return `Passes ${ids.map((id) => `#${id.toString()}`).join(", ")} minted — welcome to the club.`;
}

function StepButton({
  label,
  testId,
  disabled,
  onClick,
}: {
  label: string;
  testId: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label === "+" ? "Increase quantity" : "Decrease quantity"}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 30,
        height: 30,
        borderRadius: 8,
        border: `1px solid ${disabled ? C.lineSoft : C.line}`,
        background: "rgba(255,255,255,0.04)",
        color: disabled ? C.faint : C.text,
        fontFamily: F.mono,
        fontWeight: 800,
        fontSize: 15,
        cursor: disabled ? "not-allowed" : "pointer",
        lineHeight: 1,
      }}
    >
      {label}
    </button>
  );
}

// ============================================================ utility copy

function UtilityCopy() {
  return (
    <section
      style={{
        padding: 16,
        borderRadius: 14,
        border: `1px solid ${C.purple}44`,
        background: `${C.purple}0d`,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          fontFamily: F.mono,
          fontSize: 10,
          letterSpacing: "0.16em",
          fontWeight: 800,
          color: C.purple,
          textTransform: "uppercase",
        }}
      >
        What a pass gets you
      </div>
      <ul style={{margin: 0, paddingLeft: 16, fontSize: 12, color: C.text, lineHeight: 1.7}}>
        <li>
          <strong>2 lifetime free launches per pass</strong> — skip the slot cost on any week's
          launch window.
        </li>
        <li>
          Credits are keyed to the NFT, not your wallet — they{" "}
          <strong>travel with the pass on transfer</strong>. Sell a pass, its remaining credits
          go with it.
        </li>
        <li>
          Founding-member roster is public — your address is on the wall below.
        </li>
      </ul>
      <p style={{margin: 0, fontSize: 11, color: C.dim, lineHeight: 1.5}}>
        Proceeds fund the security audit + treasury seed + ops. Bounded utility, full terms
        documented — no yield, no governance, no promises beyond the credits.
      </p>
    </section>
  );
}

// ============================================================ roster / social proof

function RosterSection({club}: {club: ClubFetchState}) {
  if (club.state === "loading") {
    return (
      <section style={rosterShellStyle}>
        <RosterLabel />
        <p style={{margin: 0, fontSize: 12, color: C.faint, fontFamily: F.mono}} className="ff-pulse">
          Loading roster…
        </p>
      </section>
    );
  }
  if (club.state === "error") {
    return (
      <section style={rosterShellStyle}>
        <RosterLabel />
        <p style={{margin: 0, fontSize: 12, color: C.faint, fontFamily: F.mono}}>
          Roster unavailable — the mint works without it.
        </p>
      </section>
    );
  }

  const data = club.data;
  // Indexer zero-state contract (spec §47.3.8): `maxSupply: 0` means the
  // pass isn't indexed yet — render the "mint not live" skeleton instead of
  // an empty roster that would read as "nobody minted".
  if (data.maxSupply === 0) {
    return (
      <section data-testid="club-mint-not-live" style={rosterShellStyle}>
        <RosterLabel />
        <p style={{margin: 0, fontSize: 12, color: C.dim, lineHeight: 1.5}}>
          The Filter Club mint isn't live yet. The founding-member roster and credit ledger
          appear here the moment the first pass mints.
        </p>
      </section>
    );
  }

  const eth = (wei: string) => {
    try {
      return fmtEthFromWei(BigInt(wei));
    } catch {
      return "Ξ —";
    }
  };

  return (
    <section data-testid="club-roster" style={rosterShellStyle}>
      <RosterLabel />

      <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 12}}>
        <Stat k="Proceeds" v={`${eth(data.proceedsWei)} / Ξ${AUDIT_BUDGET_ETH}`} tone={C.green} />
        <Stat k="Credits issued" v={String(data.credits.issued)} />
        <Stat k="Consumed" v={String(data.credits.consumed)} />
        <Stat k="Outstanding" v={String(data.credits.outstanding)} tone={C.yellow} />
      </div>

      {data.holders.length > 0 && (
        <div style={{display: "flex", flexDirection: "column", gap: 4}}>
          <div style={rosterSubLabelStyle}>Founding members ({data.holders.length})</div>
          {data.holders.map((h) => (
            <div
              key={h.address}
              style={{
                display: "grid",
                gridTemplateColumns: "110px 1fr 90px",
                gap: 8,
                fontFamily: F.mono,
                fontSize: 12,
                color: C.dim,
                padding: "4px 8px",
                borderRadius: 6,
                background: "rgba(255,255,255,0.02)",
              }}
            >
              <span style={{color: C.text}} title={h.address}>
                {shortAddr(h.address)}
              </span>
              <span>{h.tokenIds.map((id) => `#${id}`).join(" ")}</span>
              <span style={{color: h.creditsRemaining > 0 ? C.yellow : C.faint, textAlign: "right"}}>
                {h.creditsRemaining} credit{h.creditsRemaining === 1 ? "" : "s"}
              </span>
            </div>
          ))}
        </div>
      )}

      {data.recentRedemptions.length > 0 && (
        <div style={{display: "flex", flexDirection: "column", gap: 4}}>
          <div style={rosterSubLabelStyle}>Recent credit redemptions</div>
          {data.recentRedemptions.map((r, i) => (
            <div
              key={`${r.seasonId}-${r.creator}-${i}`}
              style={{
                display: "flex",
                gap: 10,
                fontFamily: F.mono,
                fontSize: 11,
                color: C.dim,
                padding: "3px 8px",
              }}
            >
              <span style={{color: C.cyan}}>S{r.seasonId}</span>
              <span title={r.creator}>{shortAddr(r.creator)}</span>
              <span>pass #{r.tokenId}</span>
              <span style={{color: r.status === "RECLAIMED" ? C.yellow : C.green}}>
                {r.status === "RECLAIMED" ? "reclaimed (season aborted)" : "free launch"}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const rosterShellStyle: React.CSSProperties = {
  padding: 16,
  borderRadius: 14,
  border: `1px solid ${C.line}`,
  background: "rgba(255,255,255,0.03)",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const rosterSubLabelStyle: React.CSSProperties = {
  fontFamily: F.mono,
  fontSize: 10,
  color: C.faint,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  marginBottom: 2,
};

function RosterLabel() {
  return (
    <span
      style={{
        fontFamily: F.mono,
        fontWeight: 800,
        fontSize: 10,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        color: C.pink,
      }}
    >
      The roster
    </span>
  );
}

function Stat({k, v, tone}: {k: string; v: string; tone?: string}) {
  return (
    <div>
      <div
        style={{
          fontFamily: F.mono,
          fontSize: 9,
          color: C.faint,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        {k}
      </div>
      <div style={{fontFamily: F.mono, fontSize: 14, fontWeight: 800, color: tone ?? C.text, fontVariantNumeric: "tabular-nums"}}>
        {v}
      </div>
    </div>
  );
}

// ============================================================ not-deployed state

function NotDeployedCard() {
  return (
    <section
      data-testid="club-not-deployed"
      aria-live="polite"
      style={{
        padding: 18,
        borderRadius: 14,
        border: `1px solid ${C.cyan}55`,
        background: `${C.cyan}0d`,
        color: C.text,
      }}
    >
      <div
        style={{
          fontFamily: F.mono,
          fontSize: 10,
          letterSpacing: "0.16em",
          fontWeight: 800,
          color: C.cyan,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        Mint not live here
      </div>
      <p style={{margin: 0, fontSize: 13, color: C.dim, lineHeight: 1.5}}>
        The Filter Club pass contract isn't deployed in this environment. Switch to the
        production network (top-right network selector) to mint a pass.
      </p>
    </section>
  );
}
