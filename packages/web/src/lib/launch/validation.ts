/// Form-field validation for the /launch page (spec §4.6 + §18.5).
///
/// These rules also gate the API route — when /api/metadata receives a
/// payload, it re-validates before pinning. The contract stores the
/// metadataURI as an opaque string by design (per spec §4.6 + ROADMAP
/// note "field validation is off-chain"), so this is the only enforcement
/// layer between user input and a permanent on-chain artifact.

export type LaunchFormFields = {
  name: string;
  ticker: string;
  description: string;
  imageUrl: string;
  website?: string;
  twitter?: string;
  farcaster?: string;
};

export type FieldErrors = Partial<Record<keyof LaunchFormFields, string>>;

const TICKER_RE = /^[A-Z0-9]{2,10}$/;
const HTTPS_RE = /^https:\/\/[^\s]+$/i;

/// Sync validation. Returns `{}` when valid; otherwise per-field error
/// messages. Ticker uniqueness is checked separately (debounced) against
/// the indexer's /tokens response.
export function validateLaunchFields(fields: LaunchFormFields): FieldErrors {
  const errs: FieldErrors = {};

  const name = fields.name.trim();
  if (name.length < 2) errs.name = "Name must be at least 2 characters.";
  else if (name.length > 32) errs.name = "Name max 32 characters.";

  const ticker = fields.ticker.trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) {
    errs.ticker = "Ticker must be 2–10 chars, A–Z and 0–9 only.";
  }

  const description = fields.description.trim();
  if (description.length < 16) errs.description = "Description must be at least 16 characters.";
  else if (description.length > 280) errs.description = "Description max 280 characters.";

  const imageUrl = fields.imageUrl.trim();
  if (!HTTPS_RE.test(imageUrl)) errs.imageUrl = "Image URL must start with https://.";

  if (fields.website && fields.website.trim().length > 0 && !HTTPS_RE.test(fields.website.trim())) {
    errs.website = "Website must be a https:// URL.";
  }
  if (fields.twitter && fields.twitter.trim().startsWith("@")) {
    errs.twitter = "Twitter handle without the @ please.";
  }
  if (fields.farcaster && fields.farcaster.trim().startsWith("@")) {
    errs.farcaster = "Farcaster handle without the @ please.";
  }
  return errs;
}

/// Returns the canonical, on-chain-bound symbol form (uppercased + trimmed).
/// The contract uses `keccak256(bytes(symbol))` for collision detection, so
/// case-normalizing here matches the lower-case `$abc` displayed in the UI
/// to a single canonical key.
export function canonicalSymbol(raw: string): string {
  return raw.trim().toUpperCase();
}

/// Build the off-chain metadata document that gets pinned. Field names
/// follow the conventions used by Zora / Manifold token metadata so any
/// generic NFT-style consumer can read them; we add `attributes` for the
/// filter-specific labels.
export function buildMetadataDoc(fields: LaunchFormFields): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    name: fields.name.trim(),
    symbol: canonicalSymbol(fields.ticker),
    description: fields.description.trim(),
    image: fields.imageUrl.trim(),
  };
  const links: Record<string, string> = {};
  if (fields.website?.trim()) links.website = fields.website.trim();
  if (fields.twitter?.trim()) links.twitter = `https://twitter.com/${fields.twitter.trim()}`;
  if (fields.farcaster?.trim()) links.farcaster = `https://warpcast.com/${fields.farcaster.trim()}`;
  if (Object.keys(links).length > 0) doc.links = links;
  doc.attributes = [{trait_type: "platform", value: "filter.fun"}];
  return doc;
}
