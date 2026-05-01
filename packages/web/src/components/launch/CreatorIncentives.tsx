"use client";

/// Creator incentives module (spec §10 + §18.6).
///
///   ✨ Creators earn:
///   • 0.20% of all trading volume on your token while live
///   • 2.5% champion bounty if you win the week
///   • Refundable launch stake if you survive Friday's cut
///   "Creator fees stop accruing when your token is filtered or settles."

import {C, F} from "@/lib/tokens";

export function CreatorIncentives() {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 12,
        border: `1px solid ${C.green}33`,
        background: "rgba(82, 255, 139, 0.05)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 10,
          fontFamily: F.mono,
          color: C.green,
          letterSpacing: "0.16em",
          fontWeight: 800,
          textTransform: "uppercase",
        }}
      >
        <span aria-hidden>✨</span>
        Creators earn
      </div>
      <ul
        style={{
          margin: 0,
          paddingLeft: 18,
          fontSize: 12,
          color: C.text,
          lineHeight: 1.6,
          fontFamily: F.mono,
        }}
      >
        <li>
          <span style={{color: C.green, fontWeight: 800}}>0.20%</span> of all trading volume on your token while live
        </li>
        <li>
          <span style={{color: C.yellow, fontWeight: 800}}>2.5%</span> champion bounty if you win the week
        </li>
        <li>
          <span style={{color: C.cyan, fontWeight: 800}}>Refundable launch stake</span> if you survive Friday's cut
        </li>
      </ul>
      <p
        style={{
          margin: 0,
          fontSize: 10,
          color: C.faint,
          lineHeight: 1.45,
        }}
      >
        Creator fees stop accruing when your token is filtered or settles.
      </p>
    </div>
  );
}
