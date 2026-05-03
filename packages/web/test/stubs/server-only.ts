/// Vitest alias target for Next.js's `server-only` sentinel module.
///
/// `import "server-only"` is a build-time guard: in a real Next.js bundle the
/// package's `index.js` is empty (the assertion lives in its package exports
/// `react-server` condition, which throws when bundled into a browser
/// chunk). Vitest doesn't ship that resolver, so direct imports of route
/// modules under test fail with "Failed to resolve import 'server-only'".
///
/// This stub is wired via `vitest.config.ts` `resolve.alias` so the tests
/// see a no-op module — the build-time guarantee remains in place when
/// Next.js compiles for production; this file only matters in vitest.
export {};
