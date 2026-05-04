/// TS port of `TickerLib.normalize` (Solidity 0.8.26 — `packages/contracts/src/libraries/TickerLib.sol`).
///
/// Both the contract and this port MUST produce byte-for-byte identical output for any
/// ASCII input. The contract's hash is `keccak256(bytes(normalize(ticker)))`; the
/// `/season/:id/tickers/check` endpoint reproduces that hash off-chain to look up
/// reservations + blocklist entries WITHOUT a chain read. A drift between the two
/// implementations would silently let a "fresh" ticker collide on-chain.
///
/// **Normalisation pipeline (must mirror the .sol exactly — order matters):**
///   1. Trim ASCII whitespace (` \t\n\r`) from both ends. Runs FIRST so `" $FILTER "`
///      yields the same canonical form as `"$FILTER"`.
///   2. Drop a single leading `$` if present (UX convention; AFTER trim, so the `$`
///      only counts as "leading" once whitespace has been removed). `"$ PEPE"` is NOT
///      accepted: the `$`-strip leaves `" PEPE"`, the inner space is not stripped
///      (only outer trims run), and the format validator below rejects on the inner
///      space.
///   3. Uppercase ASCII letters; non-ASCII bytes pass through and trip the validator
///      below (so a homograph like Cyrillic `Е` (U+0415) is rejected at format time,
///      never silently accepted as `E`).
///   4. Validate the result matches `^[A-Z0-9]{2,10}$`. Empty / single-char /
///      over-length / punctuation / lowercase-leftover (impossible after step 3) all
///      throw `InvalidTickerFormat`.
///
/// The hash is `keccak256(bytes(normalize(ticker)))`.

import {keccak256, toBytes} from "viem";

export class InvalidTickerFormat extends Error {
  constructor(public readonly raw: string) {
    super(`InvalidTickerFormat: ${JSON.stringify(raw)}`);
    this.name = "InvalidTickerFormat";
  }
}

const ASCII_TAB = 0x09;
const ASCII_LF = 0x0a;
const ASCII_CR = 0x0d;
const ASCII_SPACE = 0x20;
const ASCII_DOLLAR = 0x24;
const ASCII_0 = 0x30;
const ASCII_9 = 0x39;
const ASCII_A_UPPER = 0x41;
const ASCII_Z_UPPER = 0x5a;
const ASCII_A_LOWER = 0x61;
const ASCII_Z_LOWER = 0x7a;

function isAsciiWhitespace(b: number): boolean {
  return b === ASCII_SPACE || b === ASCII_TAB || b === ASCII_LF || b === ASCII_CR;
}

/// Returns the canonical normalised ticker.
/// Throws `InvalidTickerFormat` when the result is outside `^[A-Z0-9]{2,10}$`.
///
/// **Encoding — viem's `toBytes` is UTF-8.** A non-ASCII codepoint like Cyrillic `Е`
/// (U+0415) becomes `0xD0 0x95`; both bytes have the high bit set and trip the
/// validator below. This matches the contract, which receives the same UTF-8 bytes
/// directly (Solidity `string` is byte-array-typed; the contract never decodes to
/// codepoints).
export function normalizeTicker(ticker: string): string {
  const raw = toBytes(ticker);
  const n = raw.length;

  // Step 1 — trim whitespace.
  let start = 0;
  while (start < n && isAsciiWhitespace(raw[start]!)) start++;
  let end = n;
  while (end > start && isAsciiWhitespace(raw[end - 1]!)) end--;

  // Step 2 — drop a single leading `$`.
  if (end > start && raw[start] === ASCII_DOLLAR) start++;

  const trimmedLen = end - start;
  // Length pre-check — uppercasing only changes case, not length.
  if (trimmedLen < 2 || trimmedLen > 10) throw new InvalidTickerFormat(ticker);

  const out = new Uint8Array(trimmedLen);
  for (let i = 0; i < trimmedLen; i++) {
    let b = raw[start + i]!;
    // Step 3 — uppercase ASCII a-z.
    if (b >= ASCII_A_LOWER && b <= ASCII_Z_LOWER) {
      b = b - 32;
    }
    // Step 4 — validate against [A-Z0-9].
    const isUpper = b >= ASCII_A_UPPER && b <= ASCII_Z_UPPER;
    const isDigit = b >= ASCII_0 && b <= ASCII_9;
    if (!isUpper && !isDigit) throw new InvalidTickerFormat(ticker);
    out[i] = b;
  }

  return new TextDecoder("utf-8", {fatal: true}).decode(out);
}

/// Hash matches `keccak256(bytes(normalize(ticker)))` from the contract.
/// Throws `InvalidTickerFormat` for invalid inputs (so callers don't accidentally
/// hash an unnormalised string).
export function hashTicker(ticker: string): `0x${string}` {
  const canonical = normalizeTicker(ticker);
  return keccak256(toBytes(canonical));
}

/// Convenience: try-normalise that returns null instead of throwing. Use when the
/// caller wants to render a friendly "invalid format" error in a 4xx response
/// without a try/catch boundary.
export function tryNormalizeTicker(ticker: string): {ok: true; canonical: string} | {ok: false} {
  try {
    return {ok: true, canonical: normalizeTicker(ticker)};
  } catch {
    return {ok: false};
  }
}
