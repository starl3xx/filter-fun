/// PII redaction helpers for log lines emitted by the events tick engine.
///
/// Audit M-Indexer-6 (Phase 1, 2026-05-01): the bare `console.error` in tick.start()
/// could leak wallet addresses if an exception's `message` quoted a query parameter.
/// `redactErrorMessage` strips them before the log line lands.
///
/// Pure module — no logger plumbing, no external deps. Keep it that way so the redaction
/// rules are vitest-able against fixture strings without booting the engine.

/// Match a 0x-prefixed 40-hex-char wallet address. Conservatively `g` so multiple
/// occurrences in one message all get redacted (an "Insufficient allowance from 0xA
/// to 0xB" style error has two).
const ADDRESS_RE = /0x[0-9a-fA-F]{40}/g;
/// Match a 0x-prefixed 64-hex-char hash (tx hash, block hash, Merkle leaf). Same
/// rationale as `ADDRESS_RE` — they're not strictly PII but they uniquely identify
/// users on-chain, and we don't want them in operational logs by default.
const HASH_RE = /0x[0-9a-fA-F]{64}/g;

/// Extract a printable error message from an unknown thrown value, then redact any
/// embedded wallet addresses or transaction hashes. Falls back to `String(err)` for
/// non-Error throws (string, number, object), still passing through the redact step.
///
/// Order matters: hash (64-hex) is matched BEFORE address (40-hex) because the
/// shorter pattern would otherwise eat the first 40 characters of a hash and
/// leave the trailing 24 hex chars unredacted in the output. Caught by the
/// regression test in `test/api/security/polishIndexerPass.test.ts`.
export function redactErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(HASH_RE, "0x<redacted-hash>").replace(ADDRESS_RE, "0x<redacted-addr>");
}

/// Best-effort error-class name. `Error.name` is the canonical surface; falls back to
/// the type name for non-Error throws (rare but possible in async stacks).
export function errName(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  return typeof err;
}
