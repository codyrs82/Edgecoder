import { defineConfig } from "vitest/config";

// Integration/e2e vitest harnesses under tests/e2e (excluded from `npm test`).
// Playwright specs run separately via `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    testTimeout: 120_000
  }
});
