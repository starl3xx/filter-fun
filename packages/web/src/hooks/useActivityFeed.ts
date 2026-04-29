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
  const [items, setItems] = useState<FeedItem[]>(() =>
    Array.from({length: 8}, (_, i) => makeFeedItem(i * 13)),
  );
  useEffect(() => {
    const id = setInterval(
      () => setItems((prev) => [makeFeedItem(0), ...prev].slice(0, maxItems)),
      2200 + Math.random() * 1800,
    );
    return () => clearInterval(id);
  }, [maxItems]);
  return items;
}
