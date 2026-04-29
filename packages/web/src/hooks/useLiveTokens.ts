"use client";

import {useEffect, useState} from "react";

import {buildComponents, SEED_TOKENS, type ComponentMix, type Token} from "@/lib/seed";
import {makeSparkline} from "@/lib/sparkline";
import {SURVIVE_COUNT} from "@/lib/tokens";

// Live token simulation. Production hook will subscribe to indexer GraphQL or
// websocket and emit `Token`s with components from the scoring engine; the
// `mix` field is simulation-only.
export function useLiveTokens(): Token[] {
  const [tokens, setTokens] = useState<Token[]>(() =>
    SEED_TOKENS.map(({mix, ...rest}, i) => ({
      ...rest,
      mcap: rest.price * rest.supply,
      spark: makeSparkline(rest.ticker, 32, rest.ch / 30),
      rank: i + 1,
      components: buildComponents(rest.score, mix),
    })),
  );

  useEffect(() => {
    const mixByTicker = new Map<string, ComponentMix>(SEED_TOKENS.map((t) => [t.ticker, t.mix]));
    const id = setInterval(() => {
      setTokens((prev) => {
        const next = prev.map((t) => {
          const drift = (Math.random() - 0.48) * 0.012;
          const newPrice = Math.max(0.0000001, t.price * (1 + drift));
          const newCh = t.ch + (Math.random() - 0.5) * 0.6;
          const newScore = Math.max(0, t.score + Math.round((Math.random() - 0.45) * 18));
          const last = t.spark[t.spark.length - 1] ?? 0.5;
          const newSpark = [...t.spark.slice(1), Math.max(0.05, Math.min(0.95, last + (Math.random() - 0.5) * 0.14))];
          const mix = mixByTicker.get(t.ticker) ?? [1, 1, 1, 1, 1];
          return {
            ...t,
            price: newPrice,
            mcap: newPrice * t.supply,
            ch: newCh,
            score: newScore,
            spark: newSpark,
            components: buildComponents(newScore, mix),
          };
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
