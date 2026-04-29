import path from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages compile from source rather than via prebuilt dist; tell Next to
  // run them through swc so it doesn't choke on TS imports across package boundaries.
  transpilePackages: ["@filter-fun/oracle", "@filter-fun/scheduler"],
  // Standalone bundles a self-contained .next/standalone/server.js with traced node_modules
  // so the runtime image doesn't need npm install. tracingRoot points at the monorepo root
  // so hoisted workspace deps get included.
  output: "standalone",
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  // Workspace packages use NodeNext-style ".js" import specifiers that resolve to .ts
  // sources. Without this, webpack errors with "Can't resolve './foo.js'" because the
  // physical file is foo.ts. Standard pattern for ESM TS in monorepos.
  webpack(config) {
    config.resolve.extensionAlias = {
      ".js": [".js", ".ts", ".tsx"],
      ".mjs": [".mjs", ".mts"],
    };
    return config;
  },
};

export default nextConfig;
