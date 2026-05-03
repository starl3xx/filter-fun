/// Production incident regression (2026-05-03):
///
/// Next.js inlines `process.env.NEXT_PUBLIC_*` references at build time as
/// string literals. Docker builds do NOT forward host env vars into the
/// build container unless explicitly declared as ARG. So even with
/// `NEXT_PUBLIC_INDEXER_URL` and `NEXT_PUBLIC_BASE_*_RPC_URL` set on Railway,
/// the docker build saw them as `undefined` and baked the dev defaults into
/// the bundle (indexer → http://localhost:42069 → mixed-content blocked in
/// HTTPS production; RPC → undefined → wagmi throw before PR #85 soft-fail).
///
/// This test asserts that for every `NEXT_PUBLIC_*` reference in `src/`,
/// the Dockerfile declares a matching ARG + ENV pair in the builder stage
/// before `npm run build`. Catches the case where a developer adds a new
/// public env var to the source but forgets to wire it through the
/// Dockerfile, which would silently bake `undefined` into production.

import {readFileSync, readdirSync, statSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function collectNextPublicVarsInSrc(): Set<string> {
  const srcDir = path.join(repoRoot, "src");
  const names = new Set<string>();
  for (const file of walk(srcDir)) {
    if (!/\.(ts|tsx|mjs|js)$/.test(file)) continue;
    const contents = readFileSync(file, "utf-8");
    for (const m of contents.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) {
      names.add(m[0]);
    }
  }
  return names;
}

describe("Dockerfile forwards every NEXT_PUBLIC_* env var to the Next.js build (prod incident 2026-05-03)", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const dockerfile = readFileSync(dockerfilePath, "utf-8");
  const usedInSrc = collectNextPublicVarsInSrc();

  it("at least one NEXT_PUBLIC_* var is referenced in src (sanity check)", () => {
    expect(usedInSrc.size, "expected to find NEXT_PUBLIC_* references in src/ — has the codebase moved them?").toBeGreaterThan(0);
  });

  it("every NEXT_PUBLIC_* var used in src/ has a matching `ARG` declaration in the Dockerfile builder stage", () => {
    const missing: string[] = [];
    for (const name of usedInSrc) {
      const argRe = new RegExp(`^ARG\\s+${name}(?:\\s|$)`, "m");
      if (!argRe.test(dockerfile)) missing.push(name);
    }
    expect(
      missing,
      `Dockerfile is missing ARG declarations for: ${missing.join(", ")}\n` +
        `Without ARG, Docker won't forward Railway's --build-arg into the build container, ` +
        `and Next.js will inline 'undefined' into the bundle (production incident 2026-05-03).`,
    ).toEqual([]);
  });

  it("every ARG NEXT_PUBLIC_* is re-exported as ENV (so npm run build sees it via process.env)", () => {
    const missing: string[] = [];
    for (const name of usedInSrc) {
      // Match `ENV FOO=$FOO` or `ENV FOO=${FOO}` — both are valid Docker syntax.
      const envRe = new RegExp(`^ENV\\s+${name}=\\$\\{?${name}\\}?(?:\\s|$)`, "m");
      if (!envRe.test(dockerfile)) missing.push(name);
    }
    expect(
      missing,
      `Dockerfile declares ARGs but doesn't re-export to ENV for: ${missing.join(", ")}\n` +
        `An ARG is only a build-arg; without re-exporting as ENV, Next.js's webpack scan ` +
        `will not see it in process.env during the build step.`,
    ).toEqual([]);
  });

  // Bugbot regression (PR #86): `ENV FOO=$FOO` with an unset ARG produces
  // `""` (empty string), not `undefined`. The `??` operator only catches
  // null/undefined, so `process.env.NEXT_PUBLIC_X ?? "fallback"` evaluates
  // to `""` instead of `"fallback"` when the ARG isn't passed — silently
  // breaking the fallback path. Assert that consumers of NEXT_PUBLIC_*
  // env vars use `||` (truthy-coerce, treats `""` as missing) for any
  // expression that has a meaningful default value, NOT `??`.
  describe("consumers of NEXT_PUBLIC_* must use `||` not `??` for fallback expressions", () => {
    const consumerFiles = [
      "src/lib/arena/api.ts",      // INDEXER_URL fallback
      "src/lib/wagmi.ts",          // chainName fallback (deploymentMeta)
    ];
    for (const rel of consumerFiles) {
      it(`${rel} must not use \`?? \` with a NEXT_PUBLIC_* read that has a non-empty fallback`, () => {
        const src = readFileSync(path.join(repoRoot, rel), "utf-8");
        // Capture `process.env.NEXT_PUBLIC_FOO ?? <token>` where <token> is
        // the start of the fallback expression (a string literal, identifier,
        // or open-paren). We then filter out fallbacks that are exactly `""`
        // because those are behaviorally identical regardless of `??` vs `||`
        // (e.g. `?? ""` for NEXT_PUBLIC_WC_PROJECT_ID — the connector code
        // accepts an empty project ID as "WC disabled" same as undefined).
        const re = /process\.env\.NEXT_PUBLIC_[A-Z0-9_]+\s*\?\?\s*(\S+)/g;
        const hits = [...src.matchAll(re)]
          .filter((m) => {
            const fallback = m[1];
            // Strip trailing punctuation that bordered the captured token
            // (`,`, `;`, `)`) so `""` and `"",` both register as empty.
            const stripped = fallback.replace(/[,;)\]}]+$/, "");
            return stripped !== '""' && stripped !== "''";
          })
          .map((m) => m[0]);
        expect(
          hits,
          `${rel} uses \`?? \` with a non-empty fallback for a NEXT_PUBLIC_* read. ` +
            `In a Docker build, an unset ARG produces \`""\` (not \`undefined\`), and \`"" ?? "fallback"\` is \`""\`. ` +
            `Use \`|| \` instead so empty strings also fall through. Found: ${hits.join(", ")}`,
        ).toEqual([]);
      });
    }
  });

  it("the ARG declarations appear BEFORE the `RUN npm run build` step (otherwise they're not in scope)", () => {
    // Search for the literal `RUN npm run build` directive (with the leading
    // `RUN ` prefix) so we don't match the same string in our own comment
    // block above the ARG declarations.
    const buildMatch = /^RUN\s+npm\s+run\s+build\b/m.exec(dockerfile);
    expect(buildMatch, "expected to find a `RUN npm run build` line in the Dockerfile").not.toBeNull();
    const buildIdx = buildMatch!.index;
    for (const name of usedInSrc) {
      // Match the directive form `^ARG NAME` (start of line) to avoid matching
      // the same literal in our own explanatory comment.
      const argMatch = new RegExp(`^ARG\\s+${name}(?:\\s|$)`, "m").exec(dockerfile);
      if (!argMatch) continue; // already failed in the ARG-presence test above
      expect(
        argMatch.index,
        `ARG ${name} appears AFTER 'RUN npm run build' — must be declared earlier in the same builder stage so it's in scope when the build runs`,
      ).toBeLessThan(buildIdx);
    }
  });
});
