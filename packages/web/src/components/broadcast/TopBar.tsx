"use client";

import {useAccount, useConnect, useDisconnect} from "wagmi";

import {Triangle} from "@/components/Triangle";
import {C, F} from "@/lib/tokens";

const NAV_ITEMS = ["Arena", "Tokens", "Missions", "Stats", "Launch"];

export function TopBar() {
  return (
    <header
      style={{
        // minHeight (not fixed height) — items wrap on narrow viewports and
        // the bar grows to fit instead of spilling over the ticker tape below.
        minHeight: 56,
        padding: "8px 22px",
        display: "flex",
        alignItems: "center",
        gap: 22,
        flexWrap: "wrap",
        borderBottom: `1px solid ${C.line}`,
        position: "relative",
        background: "rgba(10,6,18,0.6)",
        backdropFilter: "blur(10px)",
        zIndex: 2,
      }}
    >
      <div style={{display: "flex", alignItems: "center", gap: 10}}>
        <div
          aria-hidden
          style={{
            width: 32,
            height: 32,
            display: "grid",
            placeItems: "center",
            background: `linear-gradient(135deg, ${C.pink}, ${C.purple})`,
            borderRadius: 9,
            boxShadow: `0 4px 18px ${C.pink}80, inset 0 1px 0 #ffffff44`,
          }}
        >
          <Triangle size={18} />
        </div>
        <h1 style={{margin: 0, fontWeight: 800, fontSize: 20, letterSpacing: "-0.02em", fontFamily: F.display}}>
          filter
          <span
            style={{
              background: `linear-gradient(135deg, ${C.pink}, ${C.cyan})`,
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            .fun
          </span>
        </h1>
        <div
          style={{
            marginLeft: 6,
            padding: "4px 9px",
            borderRadius: 99,
            background: `linear-gradient(135deg, ${C.red}33, ${C.pink}33)`,
            color: C.red,
            fontSize: 10,
            fontWeight: 800,
            fontFamily: F.mono,
            letterSpacing: "0.1em",
            display: "flex",
            alignItems: "center",
            gap: 6,
            border: `1px solid ${C.red}55`,
          }}
        >
          <span
            className="ff-pulse"
            style={{width: 6, height: 6, borderRadius: 99, background: C.red, boxShadow: `0 0 8px ${C.red}`}}
          />
          LIVE · WK 1
        </div>
      </div>

      <nav style={{display: "flex", gap: 4, fontSize: 13, fontWeight: 700, marginLeft: 10, fontFamily: F.display}}>
        {NAV_ITEMS.map((label, i) => (
          <button
            key={label}
            type="button"
            style={{
              padding: "7px 12px",
              borderRadius: 8,
              color: i === 0 ? C.text : C.dim,
              background: i === 0 ? "rgba(255,255,255,0.06)" : "transparent",
              border: i === 0 ? `1px solid ${C.line}` : "1px solid transparent",
              fontFamily: F.display,
              fontWeight: 700,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      <div style={{flex: 1, minWidth: 8}} />

      <div style={{display: "flex", alignItems: "center", gap: 10}}>
        <div
          style={{
            padding: "5px 10px",
            borderRadius: 8,
            background: `linear-gradient(135deg, ${C.yellow}, ${C.pink})`,
            color: "#1a012a",
            fontWeight: 800,
            fontSize: 11,
            letterSpacing: "0.04em",
            fontFamily: F.display,
            boxShadow: `0 0 14px ${C.yellow}66`,
          }}
        >
          LVL 4
        </div>
        <div style={{width: 90}} aria-label="XP progress: 70 percent">
          <div style={{height: 5, background: "rgba(255,255,255,0.08)", borderRadius: 99, overflow: "hidden"}}>
            <div
              style={{
                height: "100%",
                width: "70%",
                background: `linear-gradient(90deg, ${C.yellow}, ${C.pink})`,
                boxShadow: `0 0 10px ${C.yellow}aa`,
              }}
            />
          </div>
        </div>
      </div>

      <button
        type="button"
        style={{
          padding: "9px 14px",
          borderRadius: 9,
          border: `1px solid ${C.line}`,
          background: "rgba(255,255,255,0.04)",
          color: C.text,
          fontWeight: 700,
          fontSize: 13,
          cursor: "pointer",
          fontFamily: F.display,
        }}
      >
        Launch
      </button>
      <ConnectButton />
    </header>
  );
}

function ConnectButton() {
  const {address, isConnected} = useAccount();
  const {connect, connectors, status} = useConnect();
  const {disconnect} = useDisconnect();
  const injected = connectors.find((c) => c.type === "injected");

  if (isConnected && address) {
    const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
    return (
      <button
        type="button"
        onClick={() => disconnect()}
        style={{
          padding: "9px 14px",
          borderRadius: 9,
          border: `1px solid ${C.line}`,
          background: "rgba(255,255,255,0.04)",
          color: C.text,
          fontWeight: 700,
          fontSize: 13,
          fontFamily: F.mono,
          cursor: "pointer",
        }}
        title="Disconnect"
      >
        {short}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => injected && connect({connector: injected})}
      disabled={!injected || status === "pending"}
      style={{
        padding: "9px 16px",
        borderRadius: 9,
        border: "none",
        background: `linear-gradient(135deg, ${C.pink}, ${C.purple})`,
        color: "#fff",
        fontWeight: 800,
        fontSize: 13,
        cursor: injected ? "pointer" : "not-allowed",
        fontFamily: F.display,
        boxShadow: `0 4px 16px ${C.pink}80, inset 0 1px 0 #ffffff44`,
        opacity: injected ? 1 : 0.6,
      }}
    >
      {status === "pending" ? "Connecting…" : "Connect ✦"}
    </button>
  );
}
