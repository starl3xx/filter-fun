/// Audit H-Web-1 (Phase 1, 2026-05-01) regression — wagmi connector coverage.
///
/// Pre-fix only `injected()` was wired (MetaMask / Rabby / Brave). Coinbase
/// Wallet (a stated target wallet) and every WalletConnect-based mobile wallet
/// were silently excluded. Pin the connector list here so a regression that
/// removes one or reorders them surfaces in CI.
///
/// We can't introspect the connector internals at unit-test time (each
/// connector's `id` is set at config time by wagmi), but the source-grep
/// pattern matches PR #61's CORS exposeHeaders pin and PR #63's JetBrains
/// Mono weight pin.
import * as fs from "node:fs";
import * as path from "node:path";

import {describe, expect, it} from "vitest";

const WAGMI_PATH = path.resolve(__dirname, "../../src/lib/wagmi.ts");
const source = fs.readFileSync(WAGMI_PATH, "utf8");

describe("wagmi connectors spec lock (Audit H-Web-1)", () => {
  it("imports the three required connector factories", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bcoinbaseWallet\b[^}]*\}\s*from\s*"wagmi\/connectors"/,
    );
    expect(source).toMatch(
      /import\s*\{[^}]*\binjected\b[^}]*\}\s*from\s*"wagmi\/connectors"/,
    );
    expect(source).toMatch(
      /import\s*\{[^}]*\bwalletConnect\b[^}]*\}\s*from\s*"wagmi\/connectors"/,
    );
  });

  it("wires injected() FIRST (desktop default)", () => {
    const cfgMatch = /connectors:\s*\[([\s\S]*?)\]/.exec(source);
    expect(cfgMatch, "connectors: [...] not found in wagmi.ts").not.toBeNull();
    const body = cfgMatch![1];
    const injectedIdx = body.indexOf("injected()");
    const coinbaseIdx = body.indexOf("coinbaseWallet(");
    const wcIdx = body.indexOf("walletConnect(");
    expect(injectedIdx).toBeGreaterThanOrEqual(0);
    expect(coinbaseIdx).toBeGreaterThan(injectedIdx);
    expect(wcIdx).toBeGreaterThan(coinbaseIdx);
  });

  it('coinbaseWallet uses appName "filter.fun"', () => {
    expect(source).toMatch(/coinbaseWallet\(\s*\{[^}]*appName:\s*"filter\.fun"[^}]*\}\s*\)/);
  });

  it("walletConnect reads projectId from NEXT_PUBLIC_WC_PROJECT_ID", () => {
    expect(source).toContain("NEXT_PUBLIC_WC_PROJECT_ID");
    expect(source).toMatch(/walletConnect\(\s*\{[^}]*projectId[^}]*\}\s*\)/);
  });

  it(".env.example documents NEXT_PUBLIC_WC_PROJECT_ID", () => {
    const envPath = path.resolve(__dirname, "../../.env.example");
    const env = fs.readFileSync(envPath, "utf8");
    expect(env).toContain("NEXT_PUBLIC_WC_PROJECT_ID");
  });
});
