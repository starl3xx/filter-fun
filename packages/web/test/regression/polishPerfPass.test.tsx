/// PolishPerfPassTest — Audit polish pass (Phase 1, 2026-05-03)
///
/// Bundled regressions for the code-touching items in the performance polish
/// PR. Each test maps to one finding in
/// `audit/2026-05-PHASE-1-AUDIT/performance.md` so a future revert that drops
/// the change surfaces with the audit ID in the failure label.
///
/// Findings covered (CODE only — DEFER / CLOSE-AS-PASS rows are pinned by
/// the status notes in performance.md, not by this suite):
///   - M-Perf-1: `wagmi/chains` import in `lib/wagmi.ts` stays a narrow
///     named import (`{base, baseSepolia}`) so the next/webpack tree-shake
///     keeps the chain-registry blob out of the bundle. Switching to
///     `import * as` or destructuring into a const would defeat the
///     tree-shake; this test pins the import shape so a future "tidy this
///     import" pass can't silently regress it.
///   - M-Perf-2: each token-hook (`hooks/token/*.ts`) `useReadContract`
///     query opt object carries an explicit `staleTime` matching its
///     `refetchInterval`. Without staleTime the default 0 makes every
///     window-focus / mount / reconnect re-fetch even when the active poll
///     just pulled the same data — wasted RPC on the admin / claim pages.
import {readFileSync, readdirSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
function readSource(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf-8");
}

// M-Perf-1 -----------------------------------------------------------------
//
// Pre-fix concern (audit): wagmi/chains imports could pull viem's full
// 900-chain registry into the bundle. Verification (`next build` +
// chunk inspection) showed only one chunk references base/baseSepolia
// chain ids and ZERO chunks reference other chain ids — the named-
// import form already tree-shakes correctly. Pin the import shape so a
// future refactor doesn't switch to `import * as` (which would defeat
// the tree-shake) and accidentally bloat First Load JS.
describe("M-Perf-1: wagmi/chains import in lib/wagmi.ts is the narrow named-import form", () => {
  const src = readSource("src/lib/wagmi.ts");

  it("imports exactly `{base, baseSepolia}` from `wagmi/chains` — no namespace import, no extra chains", () => {
    // Match the literal import shape. Other forms that would defeat
    // the tree-shake or expand chain coverage would not match:
    //   - `import * as chains from "wagmi/chains"`
    //   - `import { base, baseSepolia, mainnet } from "wagmi/chains"`
    //   - `const chains = require("wagmi/chains")`
    expect(src).toMatch(/import\s*\{\s*base\s*,\s*baseSepolia\s*\}\s*from\s*["']wagmi\/chains["']\s*;/);
  });

  it("does NOT import other named chains from wagmi/chains (one-line guard)", () => {
    // Pull the line that imports from wagmi/chains and assert it lists
    // exactly two named bindings.
    const m = src.match(/import\s*\{([^}]*)\}\s*from\s*["']wagmi\/chains["']/);
    expect(m).not.toBeNull();
    const names = (m?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(names.sort()).toEqual(["base", "baseSepolia"]);
  });

  it("does NOT use a namespace or wildcard import from wagmi/chains", () => {
    // Catch the regression form `import * as chains from "wagmi/chains"`
    // which would pull the full registry.
    expect(src).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s+["']wagmi\/chains["']/);
    expect(src).not.toMatch(/require\(["']wagmi\/chains["']\)/);
  });
});

// M-Perf-2 -----------------------------------------------------------------
//
// Pre-fix: each `useReadContract` in `hooks/token/*.ts` set
// `refetchInterval` but not `staleTime`. The default react-query
// staleTime is 0 — every window-focus / mount / reconnect re-fetched
// even though the poll just pulled the same data. Post-fix: every
// query opt block carries `staleTime` matching its `refetchInterval`.
describe("M-Perf-2: token hooks set explicit staleTime matching refetchInterval", () => {
  const TOKEN_HOOKS_DIR = "src/hooks/token";

  function tokenHookFiles(): string[] {
    const dir = path.join(repoRoot, TOKEN_HOOKS_DIR);
    return readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join(TOKEN_HOOKS_DIR, f));
  }

  it("every `query: {...refetchInterval...}` block in token hooks also sets staleTime", () => {
    const offenders: string[] = [];
    for (const rel of tokenHookFiles()) {
      const text = readSource(rel);
      // Match `query: { ... refetchInterval: <n>, ... }` blocks. The
      // post-fix shape always includes `staleTime` in the same object.
      // Use a `[^{}]*` body match so we don't cross object boundaries.
      const queryBlocks = text.match(/query:\s*\{[^{}]*refetchInterval[^{}]*\}/g) ?? [];
      for (const block of queryBlocks) {
        if (!/staleTime\s*:/.test(block)) {
          offenders.push(`${rel}:\n  ${block}`);
        }
      }
    }
    expect(
      offenders,
      `query opt blocks with refetchInterval but no staleTime (M-Perf-2 regression):\n${offenders.join("\n\n")}`,
    ).toEqual([]);
  });

  it("at least one token hook contains a staleTime — sanity check that the assertion above isn't vacuous", () => {
    const anyStaleTime = tokenHookFiles().some((rel) =>
      /staleTime\s*:\s*\d/.test(readSource(rel)),
    );
    expect(anyStaleTime).toBe(true);
  });

  it("arena hooks intentionally do NOT set staleTime (realtime-staleness is the contract)", () => {
    // Pin the asymmetry so a future "consistency pass" doesn't add
    // staleTime to the arena hooks — that would over-cache realtime
    // data and break the live-feel contract on the leaderboard / tickers.
    const arenaDir = "src/hooks/arena";
    const arenaFiles = readdirSync(path.join(repoRoot, arenaDir))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join(arenaDir, f));
    const arenaWithStaleTime: string[] = [];
    for (const rel of arenaFiles) {
      const text = readSource(rel);
      // Match `query: { ... staleTime: <n> ... }` blocks (regardless
      // of whether refetchInterval is also present).
      if (/query:\s*\{[^{}]*staleTime\s*:/.test(text)) {
        arenaWithStaleTime.push(rel);
      }
    }
    expect(
      arenaWithStaleTime,
      `arena hook(s) added staleTime — realtime contract regression (M-Perf-2 boundary):\n  ${arenaWithStaleTime.join("\n  ")}`,
    ).toEqual([]);
  });
});
