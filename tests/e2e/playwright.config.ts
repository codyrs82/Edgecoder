import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./flows",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["html", { open: "never" }], ["list"]],
  globalSetup: "./setup/global-setup.ts",
  globalTeardown: "./setup/global-teardown.ts",
  timeout: 120_000,
  use: {
    baseURL: "http://localhost:14310",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "portal-web",
      use: {
        browserName: "chromium",
      },
    },
  ],
});
