// Design screenshots of the built web bundle (`vite preview`) against canned backend answers.
// Run: npm run build && SHOTS_DIR=../../docs/design/screens/desktop-polish/after npx playwright test -c design-shots/playwright.config.ts
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const PORT = 4175;

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  workers: 2,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, ...devices["Desktop Chrome"], deviceScaleFactor: 1 },
  webServer: {
    command: `npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
