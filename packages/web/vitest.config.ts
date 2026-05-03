import path from "node:path";
import {fileURLToPath} from "node:url";

import react from "@vitejs/plugin-react";
import {defineConfig} from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/// Vitest configuration for the web package. Mirrors the indexer package's
/// vitest setup but adds React + jsdom for component tests.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Audit M-Web-7 (Phase 1, 2026-05-02): `import "server-only"` in
      // `src/app/api/metadata/route.ts` is a Next.js build-time guard.
      // Vitest can't resolve it without the next bundler, so tests that
      // import the route module directly fail at module load. Stub it to a
      // no-op module — the production guarantee still holds because next
      // compiles the route through its own resolver in real builds.
      "server-only": path.resolve(__dirname, "./test/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
  },
});
