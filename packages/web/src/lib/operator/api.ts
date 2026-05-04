/// `/operator/*` indexer client + response shapes.

import {INDEXER_URL} from "@/lib/arena/api";

import {getCachedOperatorRequest, operatorAuthHeaders, type OperatorSigner} from "./auth";

export interface OperatorFetchOptions {
  signer: OperatorSigner;
  signal?: AbortSignal;
}

async function operatorFetch<T>(
  path: string,
  method: "GET",
  opts: OperatorFetchOptions,
): Promise<T> {
  // The signed `action:` field is bound to the endpoint identity (method +
  // path) — query strings are NOT part of the signature so the operator can
  // change filters without re-signing. Strip any query before building the
  // action string; the server's `applyOperatorAuth` does the same with
  // `c.req.path` (which already excludes the query). See bugbot PR #95
  // round 5 (Medium): without this binding, a signature for one endpoint
  // could be replayed against another within the 5-min window.
  const queryStart = path.indexOf("?");
  const pathWithoutQuery = queryStart === -1 ? path : path.slice(0, queryStart);
  const action = `${method} /operator${pathWithoutQuery}`;
  // Bugbot PR #95 round 10 (High): use the cached variant so polling cadences
  // don't trigger a wallet popup per request. Cache reuses the same signed
  // body for 4 minutes (1-min buffer before the server's 5-min staleness),
  // making `/alerts` polling at 30s cost 1 wallet prompt per 4min instead of
  // 1 per request.
  const req = await getCachedOperatorRequest(opts.signer, action);
  const res = await fetch(`${INDEXER_URL}/operator${path}`, {
    method,
    headers: operatorAuthHeaders(req),
    signal: opts.signal,
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    const reason =
      body && typeof body === "object" && "reason" in body
        ? String((body as Record<string, unknown>).reason)
        : "unknown";
    throw new Error(`/operator${path} ${res.status} (${reason})`);
  }
  return (await res.json()) as T;
}

export interface FinancialOverview {
  flowsTotal: {
    toVaultWei: string;
    toTreasuryWei: string;
    toMechanicsWei: string;
    toCreatorWei: string;
  };
  filterFundBySeason: Array<{
    seasonId: string;
    totalPotWei: string;
    bonusReserveWei: string;
    rolloverWinnerTokens: string;
    phase: string;
  }>;
  indexedAt: number;
}

export function fetchFinancialOverview(opts: OperatorFetchOptions): Promise<FinancialOverview> {
  return operatorFetch<FinancialOverview>("/financial-overview", "GET", opts);
}

export interface SettlementHistoryEntry {
  seasonId: string;
  startedAt: string;
  vault: `0x${string}`;
  phase: string;
  winner: `0x${string}` | null;
  rolloverRoot: `0x${string}` | null;
  totalPotWei: string;
  finalizedAt: string | null;
  cutAt: string | null;
  cutBlock: string | null;
  finalizeAt: string | null;
  finalizeBlock: string | null;
}

export function fetchSettlementHistory(
  opts: OperatorFetchOptions & {limit?: number; seasonId?: string | bigint},
): Promise<{history: SettlementHistoryEntry[]}> {
  const qs = new URLSearchParams();
  if (opts.limit) qs.set("limit", String(opts.limit));
  if (opts.seasonId !== undefined) qs.set("seasonId", String(opts.seasonId));
  const path = qs.toString() ? `/settlement-history?${qs}` : "/settlement-history";
  return operatorFetch(path, "GET", opts);
}

export interface OperatorActionRow {
  id: string;
  actor: `0x${string}`;
  action: string;
  params: string;
  txHash: `0x${string}`;
  blockNumber: string;
  blockTimestamp: string;
}

export function fetchOperatorActions(
  opts: OperatorFetchOptions & {actor?: string; action?: string; limit?: number},
): Promise<{actions: OperatorActionRow[]}> {
  const qs = new URLSearchParams();
  if (opts.actor) qs.set("actor", opts.actor);
  if (opts.action) qs.set("action", opts.action);
  if (opts.limit) qs.set("limit", String(opts.limit));
  const path = qs.toString() ? `/actions?${qs}` : "/actions";
  return operatorFetch(path, "GET", opts);
}

export interface AlertEntry {
  id: string;
  level: "warn" | "error";
  source: string;
  message: string;
  since: number;
  params?: Record<string, unknown>;
}

export function fetchAlerts(opts: OperatorFetchOptions): Promise<{alerts: AlertEntry[]}> {
  return operatorFetch("/alerts", "GET", opts);
}
