import { defineConfig } from "vitest/config";

/**
 * Unit tests live next to the code they test. Playwright specs are excluded:
 * they need a browser and are run through `pnpm e2e` / playwright.config.ts.
 */
export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "tests/e2e/**", "test-results/**", "dist/**"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**/*.ts", "packages/signaling/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/test-support.ts", "**/dev.ts"],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
