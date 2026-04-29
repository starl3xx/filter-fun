"use client";

import {ActivityFeed} from "@/components/broadcast/ActivityFeed";
import {CountdownRow} from "@/components/broadcast/Countdown";
import {Featured} from "@/components/broadcast/Featured";
import {Leaderboard} from "@/components/broadcast/Leaderboard";
import {Missions} from "@/components/broadcast/Missions";
import {Stars} from "@/components/broadcast/Stars";
import {TickerTape} from "@/components/broadcast/TickerTape";
import {TopBar} from "@/components/broadcast/TopBar";
import {useActivityFeed} from "@/hooks/useActivityFeed";
import {useCountdown} from "@/hooks/useCountdown";
import {useLiveTokens} from "@/hooks/useLiveTokens";
import {SURVIVE_COUNT} from "@/lib/tokens";

export default function HomePage() {
  const tokens = useLiveTokens();
  const filterIn = useCountdown(18 * 3600 + 32 * 60 + 10);
  const finalsIn = useCountdown(2 * 86400 + 4 * 3600 + 12 * 60);
  const feed = useActivityFeed(12);

  const top = tokens[0];
  const survive = tokens.slice(0, SURVIVE_COUNT);
  const filtered = tokens.slice(SURVIVE_COUNT);

  return (
    <div style={{position: "relative", minHeight: "100vh", overflow: "hidden"}}>
      <Stars />
      <TopBar />
      <TickerTape tokens={tokens} />

      <main className="ff-grid" style={{position: "relative", zIndex: 1}}>
        <div className="ff-col-left" style={{display: "flex", flexDirection: "column", gap: 14, minWidth: 0}}>
          <Featured token={top} />
          <Missions tokens={tokens.filter((t) => t.status === "finalist")} />
        </div>

        <div style={{display: "flex", flexDirection: "column", gap: 14, minWidth: 0}}>
          <CountdownRow filterIn={filterIn} finalsIn={finalsIn} />
          <Leaderboard survive={survive} filtered={filtered} filterIn={filterIn} />
        </div>

        <div className="ff-col-right" style={{display: "flex", flexDirection: "column", minWidth: 0, minHeight: 480}}>
          <ActivityFeed feed={feed} />
        </div>
      </main>
    </div>
  );
}
