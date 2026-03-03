import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTEXT_FILE = resolve(__dirname, "../test-context.json");

function loadContext() {
  return JSON.parse(readFileSync(CONTEXT_FILE, "utf-8"));
}

test.describe("Portal Web UI", () => {
  test("portal serves the web application", async ({ page }) => {
    await page.goto("/");
    // Portal should serve some HTML content
    await expect(page).toHaveTitle(/.+/);
  });

  test("portal login page renders", async ({ page }) => {
    await page.goto("/login");
    // Should have email and password fields
    const emailInput = page.locator('input[type="email"], input[name="email"]');
    const passwordInput = page.locator('input[type="password"], input[name="password"]');
    // At least one of these patterns should exist
    const hasForm = (await emailInput.count()) > 0 || (await passwordInput.count()) > 0;
    expect(hasForm).toBe(true);
  });

  test("portal shows content after authentication", async ({ page }) => {
    const ctx = loadContext();
    // Set session cookie for authenticated access
    await page.context().addCookies([
      {
        name: "edgecoder_portal_session",
        value: ctx.sessionToken,
        domain: "localhost",
        path: "/",
      },
    ]);
    await page.goto("/");
    // Authenticated page should load without redirect to login
    await page.waitForLoadState("networkidle");
    // Page should have meaningful content (not just a blank page)
    const bodyText = await page.textContent("body");
    expect(bodyText?.length).toBeGreaterThan(10);
  });
});
