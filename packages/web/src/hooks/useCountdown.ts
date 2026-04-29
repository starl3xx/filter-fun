"use client";

import {useEffect, useState} from "react";

// Decrements 1 per second, clamped at 0. Production should derive from a server
// `endsAt` timestamp so the count is correct after a hard reload.
export function useCountdown(initialSec: number): number {
  const [sec, setSec] = useState(initialSec);
  useEffect(() => {
    const id = setInterval(() => setSec((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, []);
  return sec;
}
