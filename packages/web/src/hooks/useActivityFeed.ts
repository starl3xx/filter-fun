"use client";

import {useEffect, useState} from "react";

import {FEED_TEMPLATES, FEED_TICKERS, type FeedItem} from "@/lib/seed";

let feedSeq = 0;
function makeFeedItem(secondsAgo = 0): FeedItem {
  const tpl = FEED_TEMPLATES[Math.floor(Math.random() * FEED_TEMPLATES.length)]!;
  const ticker = FEED_TICKERS[Math.floor(Math.random() * FEED_TICKERS.length)]!;
  const n = Math.floor(Math.random() * 80) + 5;
  return {
    id: ++feedSeq,
    type: tpl.type,
    ticker,
    text: tpl.text(ticker, n),
    ago: secondsAgo,
  };
}

export function useActivityFeed(maxItems = 14): FeedItem[] {
  // Empty initial state so server and client agree during hydration. The seed
  // batch is generated client-side in the effect below.
  const [items, setItems] = useState<FeedItem[]>([]);

  useEffect(() => {
    setItems(Array.from({length: 8}, (_, i) => makeFeedItem(i * 13)));

    const newItem = setInterval(
      () => setItems((prev) => [makeFeedItem(0), ...prev].slice(0, maxItems)),
      2200 + Math.random() * 1800,
    );
    // Tick existing items' age once per second so "12s ago" actually advances.
    // Without this every prepended item is locked at ago=0 forever.
    const ageTick = setInterval(
      () => setItems((prev) => prev.map((it) => ({...it, ago: it.ago + 1}))),
      1000,
    );
    return () => {
      clearInterval(newItem);
      clearInterval(ageTick);
    };
  }, [maxItems]);

  return items;
}
