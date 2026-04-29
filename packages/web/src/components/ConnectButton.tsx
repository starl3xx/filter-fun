"use client";

import {useAccount, useConnect, useDisconnect} from "wagmi";

export function ConnectButton() {
  const {address, isConnected, chain} = useAccount();
  const {connect, connectors, status} = useConnect();
  const {disconnect} = useDisconnect();

  if (isConnected && address) {
    const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
    return (
      <div style={{display: "flex", alignItems: "center", gap: 12}}>
        <span style={{color: "var(--muted)", fontSize: 14}}>
          {chain?.name ?? "unknown chain"} · <code>{short}</code>
        </span>
        <button className="secondary" onClick={() => disconnect()}>
          Disconnect
        </button>
      </div>
    );
  }

  const injected = connectors.find((c) => c.type === "injected");
  if (!injected) {
    return <span style={{color: "var(--muted)"}}>No injected wallet detected.</span>;
  }
  return (
    <button onClick={() => connect({connector: injected})} disabled={status === "pending"}>
      {status === "pending" ? "Connecting…" : "Connect Wallet"}
    </button>
  );
}
