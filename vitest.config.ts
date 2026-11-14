import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// desktop/tests import the desktop app's packages (svelte, @tauri-apps/*). Without
// `npm ci --prefix desktop` they can't load, so a fresh clone (or an agent hook running `npm test`)
// skips them instead of failing; CI installs them and runs them.
const desktopDeps = existsSync("desktop/node_modules/svelte");
if (!desktopDeps) console.warn("[vitest] desktop/tests skipped: run `npm ci --prefix desktop` to include them");

export default defineConfig({
  test: {
    // desktop/tests: framework-free desktop modules (endpoints, CSP) run in the root suite.
    include: ["tests/**/*.test.ts", "src/**/__tests__/*.test.ts", ...(desktopDeps ? ["desktop/tests/**/*.test.ts"] : []), "packages/*/tests/**/*.test.ts"],
    // #7: e2e/integration harnesses (docker compose, Playwright, long simulations)
    // run via `npm run test:integration` / `npm run test:e2e`, not in unit CI.
    exclude: ["dist/**", "node_modules/**", "tests/e2e/**"],
    testTimeout: 15_000,
    // #17: coverage. Off unless `--coverage` is passed (`npm run test:coverage`), so `npm test`
    // neither loads nor needs the provider package (@vitest/coverage-v8, same version as vitest).
    coverage: {
      provider: "v8",
      // text-summary: the totals in the job log. lcov: for upload and editors. json-summary: for scripts.
      reporter: ["text-summary", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      // Every source file counts, including ones no test imports.
      include: ["src/**/*.ts"],
      exclude: ["src/**/__tests__/**", "src/**/*.test.ts", "src/**/*.d.ts"],
      // Provisional floor: coverage could not be measured when this was added. On the first run,
      // set each number to the measured value minus 2 points, and raise it as coverage grows.
      thresholds: { statements: 40, branches: 40, functions: 40, lines: 40 }
    }
  }
});
