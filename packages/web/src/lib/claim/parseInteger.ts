/// Audit M-Web-4 (Phase 1, 2026-05-02): integer-coerce-then-bigint helper for
/// the claim parsers. Pre-fix the rollover/bonus parsers fed `o.share` /
/// `o.amount` directly to `BigInt(...)` — `BigInt("1.5")` throws a low-level
/// `SyntaxError: Cannot convert 1.5 to a BigInt` that surfaces on the user's
/// "Parse" click as raw text in the error row, with no field context.
///
/// This helper performs the integer check *before* the BigInt coercion and
/// throws an Error whose message names the field plus the rejected value, so
/// the on-screen error reads "share must be an integer (got 1.5)" instead.
///
/// Accepts:
///   - JS `number` (must be finite + integer, by `Number.isInteger`)
///   - decimal string of digits (with optional leading `-`), validated by
///     a strict regex before BigInt conversion
///
/// Rejects:
///   - non-finite numbers (NaN, Infinity, -Infinity)
///   - fractional numbers (1.5, -0.001)
///   - hex / binary / octal / underscore-separated string forms (BigInt
///     itself accepts `"0xFF"` etc., which the oracle never emits and a
///     hostile payload should not be allowed to slip through)
///   - empty string, whitespace-only string
///   - non-string / non-number inputs (typed back-stop in case the
///     upstream typeof check is removed)
export function toIntegerBigInt(value: unknown, fieldName: string): bigint {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${fieldName} must be an integer (got ${value})`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    // Trim once so accidental whitespace from copy/paste is forgiven, but
    // empty / whitespace-only payloads still reject.
    const trimmed = value.trim();
    if (trimmed === "") {
      throw new Error(`${fieldName} must be a non-empty integer string`);
    }
    // Strict decimal-integer pattern. Disallow hex / scientific notation /
    // underscores / leading + because BigInt's permissive parser would
    // otherwise accept them. The oracle emits decimal-only.
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(`${fieldName} must be an integer (got ${value})`);
    }
    return BigInt(trimmed);
  }
  throw new Error(`${fieldName} must be a string or number`);
}
