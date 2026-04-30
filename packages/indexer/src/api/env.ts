/// Shared env-parsing helpers for the API config loaders.
///
/// `cache.ts` and `ratelimit.ts` both load configuration from `process.env` with the same
/// validation rules: positive numbers required, booleans accept the usual aliases. Two
/// identical copies would silently drift if one was later relaxed (e.g. allowing zero
/// for some knobs) and the other wasn't. One module, one rule, both call sites.

export function numEnv(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${key} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function boolEnv(env: NodeJS.ProcessEnv, key: string, dflt: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return dflt;
  const v = raw.toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  throw new Error(`${key} must be a boolean, got ${JSON.stringify(raw)}`);
}
