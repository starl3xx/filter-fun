/// Username domain logic — pure, no DB, no network. Tested in isolation.
///
/// Epic 1.24 (spec §38). Profiles attach an off-chain identity layer to a wallet:
/// a single mutable handle, set+changed by signing a deterministic message with
/// the wallet's key. This module owns every rule that gates a write:
///
///   - format: 3..32 chars, ASCII alphanumerics + dash (no spaces, no
///     underscores — chosen so handles round-trip through URL slugs without
///     percent-encoding). Stored lowercased; the user's original casing lives
///     alongside it as the *display* form.
///   - reserved blocklist: short list of protocol/operator words. Operator-
///     extensible (the storage layer can append more at runtime); the *baseline*
///     list lives here as a constant so the test surface is stable.
///   - cooldown: a username can be changed at most once per 30 days. Reason:
///     pre-mainnet identity stability — we want to dissuade username squatting
///     by repeatedly cycling through fresh handles. 30d picked as a default;
///     `usernameUpdatedAt` on the storage row is the input.
///   - signed-message auth: `recover(signature, message) === address`. The
///     message format is:
///       `filter.fun:set-username:<lowercased-address>:<lowercased-username>:<nonce>`
///     The colon-delimited fields disambiguate the action ("set-username" is a
///     stable namespace). `nonce` is a caller-supplied opaque string included so
///     a future write surface can require monotonicity / replay-protection
///     without changing the signed-message format. v1 ignores the nonce on the
///     server (the per-user cooldown + uniqueness on (address, username) make
///     replay benign), but it's part of the signed payload from day one so we
///     can begin enforcing it later without breaking deployed wallet clients.
///
/// What lives elsewhere:
///   - the actual `recoverMessageAddress` call lives in the handler (it's
///     async + viem-bound). This module only constructs the message string and
///     exposes the format for the recovery to consume.
///   - the storage adapter handles uniqueness + cooldown row reads/writes;
///     this module exposes pure predicates (`isWithinCooldown`, etc.) so the
///     handler can compose the rules.

/// Length bounds (inclusive). The lower bound rejects single-letter handles
/// that would collide with hex prefixes; the upper bound is a UI limit (32
/// chars renders cleanly in profile headers without truncation on mobile).
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

/// 30 days. Spec §38 default; configurable at the storage layer if we ever
/// need to dial it tighter (pre-mainnet flexibility) or looser (post-launch
/// settled identity).
export const USERNAME_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/// Baseline reserved-word blocklist. Conservative — the operator can extend
/// this set via storage, but the constants below are guaranteed-blocked
/// regardless of storage state, so the test surface (and any future config
/// regression) can't accidentally let one of these through. All entries are
/// lowercased; comparison is case-insensitive (the validator lowercases the
/// candidate before checking).
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "filter",
  "fun",
  "official",
  "admin",
  "root",
  "system",
  "protocol",
  "creator",
  "holder",
  "winner",
  "champion",
  "genesis",
  "bankr",
  "starl3xx",
  // Bugbot M PR #102 pass-15: collides with the literal API path segment
  // `/profile/username/:username/available`. A user with handle `username`
  // would still resolve correctly at `/profile/:identifier` via the
  // single-path-segment matcher, but reserving it removes the human-side
  // confusion (URL gymnastics + future support questions).
  "username",
]);

export type UsernameFormatError =
  | "too-short"
  | "too-long"
  | "invalid-chars"
  | "empty";

/// Result of `validateUsernameFormat`. Discriminated so callers don't accidentally
/// use the normalized form when the input was rejected.
export type ValidateUsernameResult =
  | {ok: true; canonical: string; display: string}
  | {ok: false; error: UsernameFormatError};

/// Format validation only. Does NOT consult the blocklist (that's
/// `isReserved`) or the cooldown / uniqueness rules (those need storage).
///
/// `display` preserves the user's original casing so the UI can render
/// "StarBreaker" while the canonical key is "starbreaker". Both are returned
/// so the caller doesn't have to re-normalize.
export function validateUsernameFormat(raw: string): ValidateUsernameResult {
  if (raw.length === 0) return {ok: false, error: "empty"};
  if (raw.length < USERNAME_MIN_LENGTH) return {ok: false, error: "too-short"};
  if (raw.length > USERNAME_MAX_LENGTH) return {ok: false, error: "too-long"};
  if (!/^[a-zA-Z0-9-]+$/.test(raw)) return {ok: false, error: "invalid-chars"};
  return {ok: true, canonical: raw.toLowerCase(), display: raw};
}

/// True if the candidate is in the baseline reserved list. The *operator*
/// blocklist is layered on top in the storage adapter — this only covers the
/// permanent, code-pinned set.
///
/// `candidate` is lowercased internally so this can be called against either
/// the canonical or display form without ambiguity.
export function isReserved(candidate: string): boolean {
  return RESERVED_USERNAMES.has(candidate.toLowerCase());
}

/// Cooldown predicate. `lastUpdatedAt` may be null (the user has never set a
/// username, or a row exists without a username having been chosen yet — in
/// which case there's nothing to gate against). `now` is injected so tests
/// can pin time without monkey-patching `Date.now`.
export function isWithinCooldown(
  lastUpdatedAt: Date | null,
  now: Date,
  cooldownMs: number = USERNAME_COOLDOWN_MS,
): boolean {
  if (lastUpdatedAt === null) return false;
  return now.getTime() - lastUpdatedAt.getTime() < cooldownMs;
}

/// Build the signed-message body for `set-username`. Both fields are
/// lowercased before interpolation so the signing client can be sloppy about
/// casing without breaking server-side recovery (the server lowercases the
/// `address` and `username` query params before construction too).
///
/// `nonce` is opaque to this module — caller-controlled. Including it in the
/// signed payload from v1 keeps the door open for replay-protection without
/// a wallet-client breaking change.
///
/// SECURITY: mirrored in `packages/web/src/lib/arena/api.ts:buildSetUsernameMessage`
/// (bugbot M PR #102 pass-5). The two copies MUST stay byte-identical — drift
/// makes every wallet's `personal_sign` recover to a different address and
/// every set-username POST returns 401. Both copies are pinned by literal-
/// format tests:
///   - indexer: `test/api/username.test.ts` "formats with all fields lowercased"
///   - web:     `test/profile/SetUsernameMessageParity.test.ts`
/// If you change this string, change BOTH and update both tests in the same
/// commit.
///
/// PR #102 pass-17: callers SHOULD pass an already-lowered `username` (the
/// server passes `formatResult.canonical`, the web modal passes
/// `value.toLowerCase()`). The internal `.toLowerCase()` here is the
/// load-bearing safety net — both parity tests exist precisely to catch a
/// future refactor that drops it. If you ever do drop it, both literal-
/// format tests fail simultaneously; the symmetry is intentional.
export function buildSetUsernameMessage(
  address: `0x${string}`,
  username: string,
  nonce: string,
): string {
  return `filter.fun:set-username:${address.toLowerCase()}:${username.toLowerCase()}:${nonce}`;
}

/// Compose the full validation gauntlet against an in-memory state snapshot.
/// Returns the first failing rule (caller maps to wire error). The storage-
/// agnostic shape lets handler tests exercise every branch without booting a
/// DB.
export type SetUsernameRejection =
  | {error: "invalid-format"; detail: UsernameFormatError}
  | {error: "blocklisted"}
  | {error: "taken"}
  | {error: "cooldown-active"; nextEligibleAt: Date};

export interface CooldownContext {
  /// Last update timestamp for THIS profile (the address attempting to set).
  /// Null = never set / new profile.
  lastUpdatedAt: Date | null;
  /// Window in ms; defaults to `USERNAME_COOLDOWN_MS`. Tests / future feature
  /// flag override.
  cooldownMs?: number;
}

export interface UniquenessContext {
  /// True iff `canonical` is already taken by a *different* address. The
  /// storage adapter resolves this against an indexed (lowercased) lookup.
  /// Note: re-setting the same username on the same address should NOT
  /// rev the cooldown (caller can short-circuit before this check); a
  /// repeated identical write is a no-op.
  takenByOther: boolean;
}

export interface OperatorBlocklistContext {
  /// True iff `canonical` is in the operator-extended blocklist. Layered on
  /// top of the baseline `RESERVED_USERNAMES`.
  operatorBlocked: boolean;
}

/// Pure rejection chain. Returns the first violation, or `null` if every rule
/// passes. The caller then performs the actual write (or returns 200).
export function evaluateSetUsername(
  raw: string,
  cooldown: CooldownContext,
  uniqueness: UniquenessContext,
  operator: OperatorBlocklistContext,
  now: Date,
): {ok: true; canonical: string; display: string} | SetUsernameRejection {
  const formatResult = validateUsernameFormat(raw);
  if (!formatResult.ok) {
    return {error: "invalid-format", detail: formatResult.error};
  }
  if (isReserved(formatResult.canonical) || operator.operatorBlocked) {
    return {error: "blocklisted"};
  }
  if (uniqueness.takenByOther) {
    return {error: "taken"};
  }
  if (
    isWithinCooldown(
      cooldown.lastUpdatedAt,
      now,
      cooldown.cooldownMs ?? USERNAME_COOLDOWN_MS,
    )
  ) {
    const nextEligibleAt = new Date(
      cooldown.lastUpdatedAt!.getTime() +
        (cooldown.cooldownMs ?? USERNAME_COOLDOWN_MS),
    );
    return {error: "cooldown-active", nextEligibleAt};
  }
  return {ok: true, canonical: formatResult.canonical, display: formatResult.display};
}

/// Identifier disambiguation for `/profile/:identifier`. Address-shaped
/// strings (40 lowercased hex chars after `0x`) route to address lookup;
/// anything else routes to username lookup. Mixed-case addresses are accepted
/// by lowercasing first.
export type IdentifierKind =
  | {kind: "address"; address: `0x${string}`}
  | {kind: "username"; username: string}
  | {kind: "invalid"};

export function classifyIdentifier(raw: string): IdentifierKind {
  if (raw.length === 0) return {kind: "invalid"};
  const lower = raw.toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(lower)) {
    return {kind: "address", address: lower as `0x${string}`};
  }
  // For non-address identifiers we MUST run the same format validation we
  // apply on write — otherwise a malformed username (whitespace, control
  // chars) becomes a SQL parameter and we'd lean entirely on the
  // parameterized query for safety. Cheap to check up front, plus it lets
  // us return a clearer 404 vs 400 distinction at the route.
  const fmt = validateUsernameFormat(raw);
  if (!fmt.ok) return {kind: "invalid"};
  return {kind: "username", username: fmt.canonical};
}
