import { defineConfig } from "vitest/config";

/**
 * Unit tests live next to the code they test. Playwright specs are excluded:
 * they need a browser and are run through `pnpm e2e` / playwright.config.ts.
 */
export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "tests/e2e/**",
      "test-results/**",
      "dist/**",
    ],
    environment: "node",
    coverage: {
      provider: "v8",
      // docs/01 §8 / plan DoD: the protocol core must stay above 80% line coverage.
      // The Go signaling server lives outside the TypeScript workspace; it is covered by
      // `go test` and the zero-storage/e2e jobs in CI, not by this coverage target.
      include: ["packages/core/src/**/*.ts"],
      // rtc.ts is browser WebRTC glue exercised by the Playwright suite; index.ts is a barrel.
      exclude: [
        "**/*.test.ts",
        "packages/core/src/index.ts",
        "packages/core/src/rtc.ts",
      ],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
