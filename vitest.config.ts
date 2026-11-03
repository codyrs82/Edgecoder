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
    testTimeout: 15_000
  }
});
