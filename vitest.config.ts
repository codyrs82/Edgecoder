import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/__tests__/*.test.ts"],
    // #7: e2e/integration harnesses (docker compose, Playwright, long simulations)
    // run via `npm run test:integration` / `npm run test:e2e`, not in unit CI.
    exclude: ["dist/**", "node_modules/**", "tests/e2e/**"],
    testTimeout: 15_000
  }
});
