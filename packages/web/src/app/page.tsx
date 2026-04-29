import {ConnectButton} from "@/components/ConnectButton";

export default function HomePage() {
  return (
    <main>
      <header style={{display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 64}}>
        <h1 style={{margin: 0, fontSize: 28, letterSpacing: -0.5}}>filter.fun</h1>
        <ConnectButton />
      </header>
      <section>
        <h2 style={{margin: "0 0 16px", fontWeight: 600}}>weekly token-launcher game</h2>
        <p style={{color: "var(--muted)", margin: "0 0 24px"}}>
          Anyone can launch a token. The off-chain scoring engine ranks them. The top-N pass the filter, one wins.
          Losing-token LP unwinds to WETH, half rolls into winner tokens for losers&rsquo; holders.
        </p>
        <p style={{color: "var(--muted)", margin: "0 0 8px"}}>
          This page is the v0 scaffold — wallet connect only. Claim, leaderboard, and finals views land in subsequent
          PRs.
        </p>
      </section>
    </main>
  );
}
