"use client";

import {useEffect, useState} from "react";

import {SEED_TOKENS, type Token} from "@/lib/seed";
import {makeSparkline} from "@/lib/sparkline";
import {SURVIVE_COUNT} from "@/lib/tokens";

// Live token simulation. Production hook will subscribe to indexer GraphQL or
// websocket; same return shape so the UI doesn't change.
export function useLiveTokens(): Token[] {
  const [tokens, setTokens] = useState<Token[]>(() =>
    SEED_TOKENS.map((t, i) => ({
      ...t,
      spark: makeSparkline(t.ticker, 32, t.ch / 30),
      rank: i + 1,
    })),
  );

  useEffect(() => {
    const id = setInterval(() => {
      setTokens((prev) => {
        const next = prev.map((t) => {
          const drift = (Math.random() - 0.48) * 0.012;
          const newPrice = Math.max(0.0000001, t.price * (1 + drift));
          const newCh = t.ch + (Math.random() - 0.5) * 0.6;
          const newScore = Math.max(0, t.score + Math.round((Math.random() - 0.45) * 18));
          const last = t.spark[t.spark.length - 1] ?? 0.5;
          const newSpark = [...t.spark.slice(1), Math.max(0.05, Math.min(0.95, last + (Math.random() - 0.5) * 0.14))];
          return {...t, price: newPrice, ch: newCh, score: newScore, spark: newSpark};
        });
        next.sort((a, b) => b.score - a.score);
        return next.map((t, i) => {
          let status: Token["status"];
          if (i < 2) status = "finalist";
          else if (i < SURVIVE_COUNT) status = "safe";
          else status = "risk";
          return {...t, status, rank: i + 1};
        });
      });
    }, 1400);
    return () => clearInterval(id);
  }, []);

  return tokens;
}
