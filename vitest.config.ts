import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/__tests__/*.test.ts"],
    // e2e/integration harnesses run via `npm run test:integration` / `npm run test:e2e`, not in unit tests.
    exclude: ["dist/**", "node_modules/**", "tests/e2e/**"],
    testTimeout: 15_000
  }
});
