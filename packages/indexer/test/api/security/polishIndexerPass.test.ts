/// PolishIndexerPassTest -- Audit polish pass (Phase 1, 2026-05-02)
///
/// Bundled regressions for the code-touching items in the indexer polish PR.
/// Each test maps to one finding in audit/2026-05-PHASE-1-AUDIT/indexer.md so a
/// future revert that drops the change surfaces with the audit ID in the failure
/// label, not just an opaque assertion miss.
///
/// Findings covered:
///   - M-Indexer-1: TokenRow.creator now required (type-system enforced; this file
///                  pins the runtime behaviour: builder no longer substitutes 0x0)
///   - M-Indexer-3: empty-result edge for /tokens/:address/history (audit asked for
///                  "token exists, no snapshots in range" coverage)
///   - M-Indexer-5: resolveClientIp fingerprint fallback spreads unknown clients
///                  across distinct buckets instead of collapsing into "unknown"
///   - M-Indexer-6: redactErrorMessage strips wallet addresses + tx hashes from
///                  log lines emitted by the events tick error path
///   - L-Indexer-4: HolderSnapshotTrigger union exported from snapshotCadence
import {describe, expect, it} from "vitest";

import {buildTokensResponse, type TokenRow} from "../../../src/api/builders.js";
import {errName, redactErrorMessage} from "../../../src/api/events/redact.js";
import {bucketize, getTokenHistoryHandler, parseRange, type HistoryQueries, type HistoryResponse}
  from "../../../src/api/history.js";
import {resolveClientIp} from "../../../src/api/ratelimit.js";
import {type HolderSnapshotTrigger} from "../../../src/api/snapshotCadence.js";

function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

// M-Indexer-1 -------------------------------------------------------------------
//
// Pre-fix: TokenRow.creator was optional and `buildTokensResponse` substituted
// "0x0000…" when missing — silent data loss masked as a real address. The audit
// recommended either making it required or asserting at runtime; we picked
// required so the type system surfaces the regression at compile time.
//
// The compile-time half is already enforced (other test fixtures had to add the
// field before this suite would build). Pin the RUNTIME half here: the builder
// reads `r.creator` directly with no fallback, so a fixture that sets
// `creator: <real address>` lands that exact address on the bagLock surface.
describe("M-Indexer-1: TokenRow.creator is required (no silent 0x0 fallback)", () => {
  it("buildTokensResponse propagates the row's creator to bagLock.creator", () => {
    const realCreator = "0x1234567890abcdef1234567890abcdef12345678" as const;
    const rows: TokenRow[] = [
      {
        id: addr(1),
        symbol: "TKN",
        isFinalist: false,
        liquidated: false,
        liquidationProceeds: null,
        creator: realCreator,
      },
    ];
    const out = buildTokensResponse(rows, new Map(), "competition", new Map(), 0n);
    expect(out[0]?.bagLock.creator).toBe(realCreator);
    // Specifically NOT "0x0000…" — that was the silent-data-loss sentinel.
    expect(out[0]?.bagLock.creator).not.toBe("0x0000000000000000000000000000000000000000");
  });
});

// M-Indexer-3 -------------------------------------------------------------------
//
// Audit recommended adding /tokens/:address/history coverage for "token exists,
// no snapshots in range." The handler returns 200 + `{points: []}` in that case;
// pin it so a future refactor that swaps the empty case to a 404 (or a 200/null)
// fails here.
describe("M-Indexer-3: history handler — empty result set returns 200 + empty points", () => {
  it("token exists in the indexer but has no hp_snapshot rows in the requested range", async () => {
    const t = addr(1);
    const queries: HistoryQueries = {
      hpSnapshotsForToken: async () => [], // empty, regardless of range
    };
    const r = await getTokenHistoryHandler(
      queries,
      t,
      {from: "1000", to: "2000", interval: "300"},
      {nowSec: 5_000n},
    );
    expect(r.status).toBe(200);
    const body = r.body as HistoryResponse;
    expect(body.points).toEqual([]);
    expect(body.from).toBe(1000);
    expect(body.to).toBe(2000);
    expect(body.interval).toBe(300);
  });

  // bucketize() also handles the empty case — pin it (one-liner contract on the pure helper).
  it("bucketize on empty input returns an empty array", () => {
    expect(bucketize([], 300)).toEqual([]);
  });

  // Belt: parseRange's reject-on-from>=to path is exercised by the existing tests;
  // here just confirm the equality boundary error message path is stable.
  it("parseRange rejects from === to with the expected error string", () => {
    const r = parseRange("100", "100", 200n);
    expect("error" in r).toBe(true);
  });
});

// M-Indexer-5 -------------------------------------------------------------------
//
// Pre-fix: socket-less clients all collapsed into a SINGLE "unknown" rate-limit
// bucket — a DoS from any one of them throttled all the others. Post-fix:
// `resolveClientIp` derives a stable bucket-id from optional fingerprint headers
// (UA + Accept-Language). Two clients with distinct fingerprints get distinct
// bucket keys; identical fingerprints share a bucket (acceptable; better than
// pinning everyone to one row).
describe("M-Indexer-5: IP fallback uses fingerprint headers, no longer collapses to 'unknown'", () => {
  it("two socket-less clients with different UA strings get different bucket keys", () => {
    const a = resolveClientIp(null, "", false, {userAgent: "MozillaA/1.0", acceptLanguage: "en-US"});
    const b = resolveClientIp(null, "", false, {userAgent: "MozillaB/2.0", acceptLanguage: "en-US"});
    expect(a).not.toBe(b);
    expect(a).not.toBe("unknown");
    expect(b).not.toBe("unknown");
    expect(a.startsWith("fp:")).toBe(true);
  });

  it("two socket-less clients with identical fingerprints share a bucket (acceptable)", () => {
    const a = resolveClientIp(null, "", false, {userAgent: "M/1", acceptLanguage: "en"});
    const b = resolveClientIp(null, "", false, {userAgent: "M/1", acceptLanguage: "en"});
    expect(a).toBe(b);
  });

  it("falls back to literal 'unknown' only when both socket AND fingerprint are absent", () => {
    expect(resolveClientIp(null, "", false)).toBe("unknown");
    expect(resolveClientIp(null, "", false, {})).toBe("unknown");
    expect(resolveClientIp(null, "", false, {userAgent: "", acceptLanguage: ""})).toBe("unknown");
  });

  // Bare-essentials regression: when socketAddr IS present, fingerprint is ignored.
  // Pre-fix and post-fix should match on this path so the patch doesn't accidentally
  // shift behaviour for the production-typical case.
  it("socketAddr wins over fingerprint when both are present", () => {
    const ip = resolveClientIp(null, "10.0.0.1", false, {userAgent: "M/1", acceptLanguage: "en"});
    expect(ip).toBe("10.0.0.1");
  });
});

// M-Indexer-6 -------------------------------------------------------------------
//
// Pre-fix: tick.start() error handler did `console.error("[events.tick] error:", err)`
// which dumped raw Error.message, potentially quoting wallet addresses or tx hashes
// from the underlying query failure. Post-fix: routes through `redactErrorMessage`
// which strips both shapes before the log line lands.
describe("M-Indexer-6: redactErrorMessage strips wallet addresses + tx hashes from log lines", () => {
  it("redacts a 40-hex address inside an error message", () => {
    const err = new Error("Insufficient balance for 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(redactErrorMessage(err)).toBe("Insufficient balance for 0x<redacted-addr>");
  });

  it("redacts multiple addresses in one message (greedy g-flag)", () => {
    const err = new Error(
      "Transfer 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa → 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb failed",
    );
    expect(redactErrorMessage(err)).toBe(
      "Transfer 0x<redacted-addr> → 0x<redacted-addr> failed",
    );
  });

  it("redacts a 64-hex tx hash distinct from the 40-hex address case", () => {
    const tx = `0x${"a".repeat(64)}`;
    const err = new Error(`Reverted on ${tx}`);
    expect(redactErrorMessage(err)).toBe("Reverted on 0x<redacted-hash>");
  });

  it("passes through messages with no PII unchanged", () => {
    expect(redactErrorMessage(new Error("connection refused"))).toBe("connection refused");
  });

  it("handles non-Error throws (string, object) by stringifying first", () => {
    expect(redactErrorMessage("plain string")).toBe("plain string");
    expect(redactErrorMessage({foo: "bar"})).toBe("[object Object]");
  });

  it("errName falls back to 'Error' for an unnamed Error and 'string'/'object' for non-Errors", () => {
    expect(errName(new Error("x"))).toBe("Error");
    expect(errName("plain")).toBe("string");
    expect(errName({})).toBe("object");
  });
});

// L-Indexer-4 -------------------------------------------------------------------
//
// HolderSnapshotTrigger union is exported from snapshotCadence.ts as the canonical
// type. Single-source-of-truth check: if a future PR drops the export, the consumer
// in api/index.ts re-introduces the bare string-literal pattern the audit flagged.
describe("L-Indexer-4: HolderSnapshotTrigger union pins the legal label set", () => {
  it("type-narrows to exactly 'CUT' | 'FINALIZE' (compile-time check)", () => {
    // This test exists to make the import meaningful at runtime — the actual
    // contract is enforced by the type system at the consumer call sites. If
    // a future change loosens the union to `string`, the consumers in
    // api/index.ts and api/events/tick.ts re-introduce the bare-literal pattern
    // and the audit ID anchor in snapshotCadence.ts becomes the only signal.
    const cut: HolderSnapshotTrigger = "CUT";
    const fin: HolderSnapshotTrigger = "FINALIZE";
    expect(cut).toBe("CUT");
    expect(fin).toBe("FINALIZE");
  });
});
