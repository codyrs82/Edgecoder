import { defineConfig } from "@playwright/test";

// Editor UI tests: real Monaco in Chromium, against harness pages served by Vite (no backend).
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:1499", browserName: "chromium", viewport: { width: 1100, height: 600 } },
  webServer: [
    {
      command: "npx vite --port 1499 --strictPort",
      cwd: "..",
      url: "http://localhost:1499/e2e/harness/inline-edit.html",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      // The real IDE server, reached cross-origin like the app's webview reaches it.
      command: "npx tsx src/apps/ide/provider-server.ts",
      cwd: "../..",
      url: "http://127.0.0.1:4324/health",
      env: { IDE_PROVIDER_PORT: "4324", IDE_ALLOWED_ORIGINS: "http://localhost:1499", OLLAMA_HOST: "http://127.0.0.1:9" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
