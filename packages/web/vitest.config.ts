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
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
  },
});
