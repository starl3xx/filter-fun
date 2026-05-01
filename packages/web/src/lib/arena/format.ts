/// Arena-specific formatters. Reuses the legacy `lib/format` helpers where
/// possible — adds the few that the indexer wire format introduces (decimal-
/// ether strings, ISO countdowns, week label).

import type {SeasonResponse} from "./api.js";

/// "Ξ14.82" from the indexer's decimal-ether string. Always two decimals
/// — matches the spec §19.5 example format exactly. Empty / non-finite
/// input renders as "Ξ0.00" so the layout doesn't shift between the
/// pre-data state and the first response.
export function fmtEth(decimalEther: string): string {
  const n = Number(decimalEther ?? "0");
  if (!Number.isFinite(n)) return "Ξ0.00";
  return `Ξ${n.toFixed(2)}`;
}

/// "+12.4%" / "-3.1%". Pass `priceChange24h` from /tokens (already a number).
export function fmtPctChange(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

/// "Week 02" — derived from seasonId. Pre-Genesis the indexer emits
/// `seasonId: 0` while no season has started; treat that as "Week —".
export function weekLabel(seasonId: number): string {
  if (!seasonId || seasonId <= 0) return "Week —";
  return `Week ${String(seasonId).padStart(2, "0")}`;
}

/// Seconds-from-now until an ISO timestamp. Negative if past. Used by the
/// top bar's local countdown ticker — we sync to the server timestamp once
/// per minute and tick locally between syncs.
export function secondsUntil(iso: string, now: Date = new Date()): number {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return 0;
  return Math.floor((target - now.getTime()) / 1000);
}

/// "HH:MM:SS" — extends `fmtCountdown` for arena's needs (handles days).
/// 72h countdowns surface as "Nd HH:MM" so the UI never shows three-digit
/// hours.
export function fmtCutCountdown(secs: number): string {
  const s = Math.max(0, secs);
  const days = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const ss = s % 60;
  if (days > 0) {
    return `${days}d ${pad(h)}:${pad(m)}`;
  }
  return `${pad(h)}:${pad(m)}:${pad(ss)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/// True iff the ISO target is within the spec'd "pre-filter" window —
/// final 10 minutes before a cut event (§20.8). Used by the ticker to
/// switch into pre-filter visual mode without waiting for an event.
export function isPreFilterWindow(season: SeasonResponse | null, now: Date = new Date()): boolean {
  if (!season) return false;
  if (season.phase === "settled") return false;
  const secs = secondsUntil(season.nextCutAt, now);
  return secs > 0 && secs <= 600;
}
