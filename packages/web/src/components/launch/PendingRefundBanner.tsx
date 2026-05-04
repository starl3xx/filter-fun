"use client";

/// Pending-refund banner — Epic 1.15c.
///
/// Renders on the /launch page when the connected wallet has unclaimed
/// `pendingRefund` slots (failed push refunds from prior aborted seasons).
/// One row per season with an unclaimed slot, a "Claim X.XX ETH" CTA per row,
/// and a tx phase indicator.
///
/// Hides when:
///   - wallet disconnected
///   - the indexer reports no unclaimed slots
///   - the wallet doesn't have an address yet (initial render)

import {useState} from "react";
import {formatEther} from "viem";
import {useAccount} from "wagmi";

import {useClaimRefund} from "@/hooks/launch/useClaimRefund";
import {usePendingRefunds} from "@/hooks/launch/usePendingRefunds";
import {C, F} from "@/lib/tokens";

export function PendingRefundBanner() {
  const {address} = useAccount();
  const {data: refunds} = usePendingRefunds(address);
  const {phase, error, claim, reset} = useClaimRefund();
  const [pendingSeasonId, setPendingSeasonId] = useState<bigint | null>(null);

  if (!address || !refunds || refunds.pending.length === 0) return null;

  const totalWei = refunds.pending.reduce((sum, r) => sum + BigInt(r.amountWei), 0n);

  async function handleClaim(seasonIdStr: string): Promise<void> {
    const sid = BigInt(seasonIdStr);
    setPendingSeasonId(sid);
    await claim(sid);
  }

  return (
    <section
      role="alert"
      style={{
        borderRadius: 14,
        border: `1px solid ${C.yellow}55`,
        background: `linear-gradient(135deg, ${C.yellow}1a, transparent 70%)`,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
        <div>
          <h3
            style={{
              margin: 0,
              fontFamily: F.display,
              fontWeight: 800,
              fontSize: 14,
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: C.yellow,
            }}
          >
            <span aria-hidden>💸</span> You have refunds to claim
          </h3>
          <div style={{fontSize: 11, color: C.dim, marginTop: 4, fontFamily: F.mono}}>
            {refunds.pending.length} season{refunds.pending.length === 1 ? "" : "s"} ·{" "}
            {formatEther(totalWei)} ETH total
          </div>
        </div>
        {phase === "success" && (
          <button
            type="button"
            onClick={reset}
            style={{
              fontFamily: F.mono,
              fontSize: 10,
              fontWeight: 700,
              color: C.dim,
              background: "transparent",
              border: `1px solid ${C.line}`,
              borderRadius: 6,
              padding: "4px 8px",
              cursor: "pointer",
            }}
          >
            DISMISS
          </button>
        )}
      </div>
      <div style={{display: "flex", flexDirection: "column", gap: 6}}>
        {refunds.pending.map((r) => {
          const eth = formatEther(BigInt(r.amountWei));
          const isPending = pendingSeasonId !== null && pendingSeasonId === BigInt(r.seasonId);
          const isInflight = isPending && (phase === "signing" || phase === "broadcasting");
          const isClaimed = isPending && phase === "success";
          return (
            <div
              key={r.seasonId}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 10px",
                borderRadius: 8,
                background: "rgba(0,0,0,0.18)",
                border: `1px solid ${C.line}`,
              }}
            >
              <div style={{display: "flex", flexDirection: "column"}}>
                <span style={{fontSize: 12, fontFamily: F.display, fontWeight: 700}}>
                  Season {r.seasonId}
                </span>
                <span style={{fontSize: 10, color: C.dim, fontFamily: F.mono}}>{eth} ETH</span>
              </div>
              <button
                type="button"
                onClick={() => void handleClaim(r.seasonId)}
                disabled={isInflight || isClaimed}
                style={{
                  fontFamily: F.mono,
                  fontSize: 11,
                  fontWeight: 800,
                  color: isClaimed ? C.green : "#1a012a",
                  background: isClaimed ? "transparent" : C.yellow,
                  border: isClaimed ? `1px solid ${C.green}66` : "none",
                  borderRadius: 6,
                  padding: "6px 12px",
                  cursor: isInflight || isClaimed ? "default" : "pointer",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  opacity: isInflight ? 0.7 : 1,
                }}
              >
                {isClaimed
                  ? "Claimed ✓"
                  : phase === "signing" && isPending
                    ? "Confirm in wallet…"
                    : phase === "broadcasting" && isPending
                      ? "Sending…"
                      : `Claim ${eth} ETH`}
              </button>
            </div>
          );
        })}
      </div>
      {error && (
        <div
          style={{
            fontSize: 11,
            color: C.red,
            fontFamily: F.mono,
            padding: "6px 10px",
            borderRadius: 6,
            border: `1px solid ${C.red}55`,
            background: `${C.red}14`,
          }}
        >
          {error}
        </div>
      )}
    </section>
  );
}
