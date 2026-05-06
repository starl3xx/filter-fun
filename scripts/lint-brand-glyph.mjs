#!/usr/bin/env node
/// Brand-kit lint — fails the build on a literal U+1F53B emoji in
/// product source under packages/. Per spec §32.4 + brand kit v1.0 the
/// only down-pointing triangle in user-visible surfaces is ▼ (U+25BC);
/// Epic 1.28 closed the last wire-payload gap and locks the rule with
/// this lint.
///
/// Scope:
///   - Scans every .ts/.tsx/.mts/.cjs/.mjs/.js/.json/.md file under
///     packages/* and docs/. Skips `node_modules`, build outputs, and
///     committed audit reports under `audit/` (those are historical
///     records that intentionally document the existence of the issue).
///   - Defensive test assertions that need the codepoint should
///     construct it dynamically via `String.fromCodePoint(0x1f53b)`
///     rather than embedding the literal — that pattern still tests
///     the absence without reintroducing the literal in source.
///
/// Usage: `node scripts/lint-brand-glyph.mjs` from repo root. Exits 0
/// on clean, 1 with a list of offending paths + line numbers otherwise.

import {readdirSync, readFileSync, statSync} from "node:fs";
import {join, relative} from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const HEAVY_TRIANGLE = String.fromCodePoint(0x1f53b);
const SCAN_DIRS = ["packages", "docs", "scripts"];
const SCAN_EXTS = new Set([".ts", ".tsx", ".mts", ".cjs", ".mjs", ".js", ".json", ".md"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "out", ".turbo", "coverage", "audit"]);

let offenders = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    const dot = name.lastIndexOf(".");
    const ext = dot < 0 ? "" : name.slice(dot);
    if (!SCAN_EXTS.has(ext)) continue;
    let buf;
    try {
      buf = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (!buf.includes(HEAVY_TRIANGLE)) continue;
    const lines = buf.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(HEAVY_TRIANGLE)) {
        offenders.push({path: relative(ROOT, full), line: i + 1, snippet: lines[i].trim()});
      }
    }
  }
}

for (const d of SCAN_DIRS) walk(join(ROOT, d));

if (offenders.length === 0) {
  console.log("✓ brand-glyph lint clean — no U+1F53B literal found.");
  process.exit(0);
}

console.error(`✗ brand-glyph lint failed — ${offenders.length} occurrence(s) of U+1F53B found.`);
console.error("   Brand kit v1.0 + spec §32.4: only ▼ (U+25BC) in product source.");
console.error("   Defensive test assertions: use String.fromCodePoint(0x1f53b) instead of a literal.");
console.error("");
for (const o of offenders) {
  console.error(`   ${o.path}:${o.line}`);
  console.error(`     ${o.snippet}`);
}
process.exit(1);
