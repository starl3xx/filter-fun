/// `POST /profile/:address/username` + `GET /profile/username/:username/available`
/// + the username-aware extension of `GET /profile/:identifier`.
///
/// Pure-ish: takes a `UserProfileStore` + a viem-shaped recoverer. The route
/// wiring in `index.ts` injects the live deps; tests inject fakes.

import {isAddressLike} from "./builders.js";
import {
  buildSetUsernameMessage,
  classifyIdentifier,
  evaluateSetUsername,
  isReserved,
  USERNAME_COOLDOWN_MS,
  validateUsernameFormat,
  type UsernameFormatError,
} from "./username.js";
import type {UserProfileRow, UserProfileStore} from "./userProfileStore.js";

/// Wire shape for the userProfile block returned alongside the existing
/// `/profile/:address` payload. `hasUsername` is convenience for clients that
/// don't want to do a null-check on every render.
export interface UserProfileBlock {
  address: `0x${string}`;
  username: string | null;
  usernameDisplay: string | null;
  hasUsername: boolean;
}

export function userProfileBlockFromRow(
  address: `0x${string}`,
  row: UserProfileRow | null,
): UserProfileBlock {
  if (row === null) {
    return {address, username: null, usernameDisplay: null, hasUsername: false};
  }
  return {
    address: row.address,
    username: row.username,
    usernameDisplay: row.usernameDisplay,
    hasUsername: row.username !== null,
  };
}

// ============================================================ Availability

/// Reasons a candidate username is unavailable. `invalid-format` is the
/// catch-all for length / charset failures; the live UI can map each to a
/// user-readable string.
export type AvailabilityReason =
  | "taken"
  | "blocklisted"
  | "invalid-format";

export interface AvailabilityResponse {
  available: boolean;
  /// Present iff `available === false`.
  reason?: AvailabilityReason;
  /// On `invalid-format`, the underlying format-validation error so the UI
  /// can render specific copy ("too short" vs. "invalid characters").
  formatDetail?: UsernameFormatError;
}

/// Check whether `raw` is currently available. Strictly informational — the
/// POST endpoint re-runs every check at write time, so a slow user that
/// holds an "available" verdict for 10 minutes might still see `taken` on
/// submit if someone else claimed it.
///
/// Note: this endpoint deliberately does NOT consult the cooldown. The same
/// wallet can call it before and after their cooldown elapses; a `taken`
/// verdict is purely about the global handle namespace, not about whether
/// THIS wallet is allowed to claim it now.
export async function checkUsernameAvailability(
  store: UserProfileStore,
  raw: string,
): Promise<AvailabilityResponse> {
  const fmt = validateUsernameFormat(raw);
  if (!fmt.ok) {
    return {available: false, reason: "invalid-format", formatDetail: fmt.error};
  }
  if (isReserved(fmt.canonical) || (await store.isOperatorBlocked(fmt.canonical))) {
    return {available: false, reason: "blocklisted"};
  }
  const taken = await store.getByUsername(fmt.canonical);
  if (taken !== null) {
    return {available: false, reason: "taken"};
  }
  return {available: true};
}

// ============================================================ Set username

/// Request body for `POST /profile/:address/username`. Defined here so the
/// route handler can validate it without leaking parsing concerns into the
/// pure module.
export interface SetUsernameRequest {
  username: string;
  signature: `0x${string}`;
  nonce: string;
}

export type SetUsernameResponse =
  | {status: 200; body: {profile: UserProfileBlock}}
  | {status: 400; body: {error: string; detail?: string}}
  | {status: 401; body: {error: "signature mismatch"}}
  | {status: 409; body: {error: "taken" | "cooldown-active"; nextEligibleAt?: string}}
  | {status: 500; body: {error: "internal error"}};

/// Caller-injected recoverer. The live route uses viem's
/// `recoverMessageAddress`; tests can inject a deterministic fixture
/// without a real key.
export type RecoverFn = (args: {
  message: string;
  signature: `0x${string}`;
}) => Promise<`0x${string}`>;

/// Body validation. Returns the typed shape on success or a 400 error
/// message on any malformed input. We don't trust the request body — every
/// field is checked for type + presence before any DB / crypto work.
function parseSetUsernameRequest(body: unknown): SetUsernameRequest | string {
  if (typeof body !== "object" || body === null) return "request body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.username !== "string") return "username is required (string)";
  if (typeof b.signature !== "string" || !b.signature.startsWith("0x")) {
    return "signature is required (0x-prefixed hex string)";
  }
  if (typeof b.nonce !== "string" || b.nonce.length === 0) {
    return "nonce is required (non-empty string)";
  }
  if (b.nonce.length > 256) {
    return "nonce too long (max 256 chars)";
  }
  return {username: b.username, signature: b.signature as `0x${string}`, nonce: b.nonce};
}

export async function setUsernameHandler(args: {
  store: UserProfileStore;
  recover: RecoverFn;
  rawAddress: string;
  body: unknown;
  now: () => Date;
  cooldownMs?: number;
}): Promise<SetUsernameResponse> {
  const {store, recover, rawAddress, body, now} = args;
  const cooldownMs = args.cooldownMs ?? USERNAME_COOLDOWN_MS;

  const lowerAddr = rawAddress.toLowerCase();
  if (!isAddressLike(lowerAddr)) {
    return {status: 400, body: {error: "invalid address"}};
  }
  const address = lowerAddr as `0x${string}`;

  const parsed = parseSetUsernameRequest(body);
  if (typeof parsed === "string") {
    return {status: 400, body: {error: "invalid request body", detail: parsed}};
  }
  const {username, signature, nonce} = parsed;

  // Pre-flight: format-validate the username BEFORE recovering the
  // signature. Recovery is comparatively expensive (keccak + ecrecover);
  // running it against an obviously-malformed username wastes CPU and lets a
  // malicious caller drain rate-limit tokens for free.
  const formatResult = validateUsernameFormat(username);
  if (!formatResult.ok) {
    return {
      status: 400,
      body: {error: "invalid username format", detail: formatResult.error},
    };
  }

  // Construct the canonical signed message ourselves — the client signs the
  // SAME format. If the message doesn't match what the user actually signed
  // (e.g. they signed a different username), recovery yields a different
  // address and the equality check fails below. This is the load-bearing
  // security boundary of the endpoint.
  const message = buildSetUsernameMessage(address, formatResult.canonical, nonce);
  let recovered: `0x${string}`;
  try {
    recovered = await recover({message, signature});
  } catch {
    // Malformed signature (bad length, unparseable v) — surface as 401, the
    // same response a *valid* signature from the wrong key would produce. We
    // don't differentiate so a probing client can't tell which fields are
    // structurally wrong vs. signed by the wrong key.
    return {status: 401, body: {error: "signature mismatch"}};
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return {status: 401, body: {error: "signature mismatch"}};
  }

  // Everything below this point assumes the request is authenticated. Now
  // run the full rejection chain against the store.
  const existing = await store.getByAddress(address);
  const operatorBlocked = await store.isOperatorBlocked(formatResult.canonical);

  // Idempotent re-set: if the wallet already owns this exact handle (case-
  // insensitive), short-circuit with 200. We do NOT advance the cooldown
  // (no row mutation), so a wallet can confirm-set without burning their
  // 30-day window.
  if (existing && existing.username === formatResult.canonical) {
    return {
      status: 200,
      body: {profile: userProfileBlockFromRow(address, existing)},
    };
  }

  const takenByOther = await store.isUsernameTakenByOther(formatResult.canonical, address);
  const verdict = evaluateSetUsername(
    username,
    {lastUpdatedAt: existing?.usernameUpdatedAt ?? null, cooldownMs},
    {takenByOther},
    {operatorBlocked},
    now(),
  );
  if ("error" in verdict) {
    // Bugbot M PR #102: exhaustive switch over the rejection union. The
    // previous version was a chain of `if ... return` branches followed by
    // an unreachable fall-through to `store.upsertUsername` — fragile,
    // because adding a new rejection variant to `SetUsernameRejection`
    // would silently bypass validation and write to the store. The
    // `_exhaustive: never` assignment makes TS fail the build the moment
    // a future variant is forgotten.
    switch (verdict.error) {
      case "blocklisted":
        return {status: 400, body: {error: "blocklisted username"}};
      case "invalid-format":
        return {status: 400, body: {error: "invalid username format", detail: verdict.detail}};
      case "taken":
        return {status: 409, body: {error: "taken"}};
      case "cooldown-active":
        return {
          status: 409,
          body: {error: "cooldown-active", nextEligibleAt: verdict.nextEligibleAt.toISOString()},
        };
      default: {
        const _exhaustive: never = verdict;
        void _exhaustive;
        return {status: 500, body: {error: "internal error"}};
      }
    }
  }

  // Commit. The race window between read and write is closed by the pg
  // unique index (other-address claim → 23505 → "taken") and the cooldown-
  // gated WHERE clause (same-address racing themselves → no rows updated →
  // "cooldown-active").
  const result = await store.upsertUsername({
    address,
    canonical: formatResult.canonical,
    display: formatResult.display,
    now: now(),
    cooldownMs,
  });
  if (result.ok) {
    return {status: 200, body: {profile: userProfileBlockFromRow(address, result.row)}};
  }
  // Same exhaustive-switch pattern as the verdict block above. If a future
  // `UpsertUsernameError` variant is added without a branch here, TS's
  // `_exhaustive: never` assignment fails the build instead of silently
  // returning a generic 500.
  switch (result.error) {
    case "taken":
      return {status: 409, body: {error: "taken"}};
    case "cooldown-active": {
      // We lost the race against ourselves — odd but possible if the same
      // wallet posts two different usernames within milliseconds. Recompute
      // nextEligibleAt from the freshly-read row.
      const refreshed = await store.getByAddress(address);
      const nextEligibleAt =
        refreshed?.usernameUpdatedAt !== undefined && refreshed.usernameUpdatedAt !== null
          ? new Date(refreshed.usernameUpdatedAt.getTime() + cooldownMs).toISOString()
          : undefined;
      return {status: 409, body: {error: "cooldown-active", nextEligibleAt}};
    }
    case "blocklisted-operator":
      return {status: 400, body: {error: "blocklisted username"}};
    default: {
      const _exhaustive: never = result.error;
      void _exhaustive;
      return {status: 500, body: {error: "internal error"}};
    }
  }
}

// ============================================================ Identifier resolution

/// Resolution helper for `GET /profile/:identifier`. Returns the lowercased
/// address the route should pass into the existing profile handler, plus the
/// `userProfile` row so the route can attach the username block.
///
/// Returns `null` when:
///   - identifier is structurally invalid, OR
///   - identifier is a username that doesn't exist
///
/// Address-shaped identifiers always resolve (no 404 from this helper), so
/// existing behavior of `/profile/:address` returning a zero-shape body for
/// unknown wallets is preserved at the route. The web layer's empty-state /
/// 404 logic is what gates the *page*, separately from this resolver.
export async function resolveProfileIdentifier(
  store: UserProfileStore,
  rawIdentifier: string,
): Promise<{address: `0x${string}`; profileRow: UserProfileRow | null} | null> {
  const classified = classifyIdentifier(rawIdentifier);
  if (classified.kind === "invalid") return null;
  if (classified.kind === "address") {
    const row = await store.getByAddress(classified.address);
    return {address: classified.address, profileRow: row};
  }
  // username path
  const row = await store.getByUsername(classified.username);
  if (row === null) return null;
  return {address: row.address, profileRow: row};
}
