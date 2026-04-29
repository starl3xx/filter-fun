import Link from "next/link";

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
      </section>
      <section style={{marginTop: 48}}>
        <h2 style={{margin: "0 0 16px", fontWeight: 600, fontSize: 18}}>Claim</h2>
        <ul style={{listStyle: "none", padding: 0, margin: 0}}>
          <ClaimLink
            href="/claim/rollover"
            title="Rollover"
            description="Winner tokens for losers' holders. Live once a season finalizes."
          />
          <ClaimLink
            href="/claim/bonus"
            title="14-day hold bonus"
            description="WETH bonus for holders who kept ≥80% of their rolled tokens. Live after the hold window."
          />
        </ul>
      </section>
    </main>
  );
}

function ClaimLink({href, title, description}: {href: string; title: string; description: string}) {
  return (
    <li style={{padding: "16px 0", borderTop: "1px solid var(--border)"}}>
      <Link href={href} style={{color: "var(--fg)", textDecoration: "none", display: "block"}}>
        <span style={{display: "block", fontWeight: 600}}>{title} →</span>
        <span style={{display: "block", color: "var(--muted)", fontSize: 14, marginTop: 4}}>{description}</span>
      </Link>
    </li>
  );
}
