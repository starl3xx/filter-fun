"use client";

/// Pre-flight ticker availability check — Epic 1.15c.
///
/// Replaces the legacy cohort-based collision check with the indexer's
/// `/season/:id/tickers/check` API. Catches every gate the contract enforces:
///   - format errors (length / punctuation / non-ASCII)
///   - protocol blocklist (FILTER, WETH, ETH, USDC, USDT, DAI, multisig adds)
///   - cross-season winner reservation (this ticker won a prior season)
///   - same-season reservation (another creator reserved before you)
///
/// Returns null when the ticker is available, otherwise an explanatory error
/// string suitable for direct display in the launch form's field error slot.
///
/// Debounced — keystrokes fire a request after 250ms idle. Aborts in-flight
/// requests on input change. Empty / too-short tickers skip the request and
/// surface no error (the form's format validator handles those locally).

import {useEffect, useState} from "react";

import {fetchTickerCheck, type TickerCheckOk, type TickerCheckResponse} from "@/lib/arena/api";
import {canonicalSymbol} from "@/lib/launch/validation";

export type TickerCheckResult = {
  /// Surfaceable error string, null when available or input is too short.
  error: string | null;
  /// Loading flag — drives a "checking…" hint while debounce / request resolves.
  loading: boolean;
  /// Canonical (post-normalise) ticker. Echoed by the API; useful so the
  /// form can preview "We'll launch as $PEPE" once the check passes.
  canonical: string | null;
};

const DEBOUNCE_MS = 250;
const MIN_LENGTH = 2;

export function useTickerCheck(
  rawTicker: string,
  seasonId: number | bigint | null | undefined,
): TickerCheckResult {
  const [state, setState] = useState<TickerCheckResult>({
    error: null,
    loading: false,
    canonical: null,
  });

  useEffect(() => {
    // Skip if the input is too short — the format validator handles "type more"
    // copy locally and a server roundtrip would just be noise.
    const sym = canonicalSymbol(rawTicker);
    if (sym.length < MIN_LENGTH || seasonId === null || seasonId === undefined) {
      setState({error: null, loading: false, canonical: null});
      return;
    }

    setState((s) => ({...s, loading: true}));
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await fetchTickerCheck(seasonId, rawTicker, {signal: controller.signal});
        const next = mapResponseToError(r);
        setState({error: next.error, loading: false, canonical: next.canonical});
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        // Network failure — don't block the user, but make the failure visible
        // so they know the local check is degraded. The chain still enforces.
        setState({
          error: "Couldn't verify ticker availability — try again",
          loading: false,
          canonical: null,
        });
      }
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [rawTicker, seasonId]);

  return state;
}

function mapResponseToError(r: TickerCheckResponse): {error: string | null; canonical: string | null} {
  if ("error" in r) {
    // 400-ish — the format validator already covers most of these, but a
    // server-side 400 means the input is truly malformed. Render generically.
    return {error: r.error, canonical: null};
  }
  const ok = r as TickerCheckOk;
  switch (ok.ok) {
    case "available":
      return {error: null, canonical: ok.canonical};
    case "blocklisted":
      return {error: `$${ok.canonical} is reserved by the protocol`, canonical: ok.canonical};
    case "winner_taken":
      return {
        error: `$${ok.canonical} won a previous season — pick a different ticker`,
        canonical: ok.canonical,
      };
    case "season_taken":
      return {
        error: `$${ok.canonical} is already reserved this season`,
        canonical: ok.canonical,
      };
  }
}
