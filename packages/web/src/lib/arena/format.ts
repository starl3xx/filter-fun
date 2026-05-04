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

/// Decimal-ether string from a wei `bigint`, with up to 6 decimal places. MUST
/// stay byte-for-byte equivalent to the indexer's `weiToDecimalEther` in
/// `packages/indexer/src/api/builders.ts` — both produce the canonical "single
/// source of truth" wire shape that the holdings panel + filter-moment recap
/// derive their projected rollover string from. Bugbot caught the original
/// truncation-vs-rounding divergence on PR #101: for wei values where the 7th
/// decimal digit is ≥ 5, truncation gives a different string and the two
/// surfaces silently disagree.
export function weiToDecimalEther(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = abs % 10n ** 18n;
  if (frac === 0n) return `${negative ? "-" : ""}${whole.toString()}`;
  const scale = 10n ** 12n;
  const halfScale = scale / 2n;
  let frac6 = (frac + halfScale) / scale;
  let carryWhole = whole;
  if (frac6 >= 10n ** 6n) {
    carryWhole += 1n;
    frac6 = 0n;
  }
  if (frac6 === 0n) return `${negative ? "-" : ""}${carryWhole.toString()}`;
  const fracStr = frac6.toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${carryWhole.toString()}.${fracStr}`;
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
///
/// Excludes both `launch` and `settled` phases: in `launch` no cut is
/// imminent (everyone SAFE per the indexer status mapping; the leaderboard
/// hides the cut line for the same reason), and in `settled` the next-cut
/// timestamp is historical. Without the launch exclusion the ticker would
/// urgently count down while the leaderboard simultaneously says "no cut" —
/// a contradiction the spectator UI must avoid.
export function isPreFilterWindow(season: SeasonResponse | null, now: Date = new Date()): boolean {
  if (!season) return false;
  if (season.phase === "launch" || season.phase === "settled") return false;
  const secs = secondsUntil(season.nextCutAt, now);
  return secs > 0 && secs <= 600;
}
