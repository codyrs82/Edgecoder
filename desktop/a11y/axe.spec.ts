// #29: no critical axe violations, and no horizontal overflow at the smallest window size.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// The Tauri window's minimum is 900x600 (desktop/src-tauri/tauri.conf.json); 1200x800 is the default.
const VIEWPORTS = [
  { width: 900, height: 600 },
  { width: 1200, height: 800 },
];

const USER = { userId: "u_a11y", email: "a11y@example.org", displayName: "A11y", emailVerified: true };

/**
 * No real backend in CI: the app runs outside Tauri, so stub every request that isn't the
 * preview server itself. `/me` decides whether we land on the login screen or the app shell.
 */
async function stubBackend(page: Page, signedIn: boolean) {
  await page.route(/^(?!http:\/\/127\.0\.0\.1:4173\/).*/, async (route) => {
    const url = route.request().url();
    if (/\/me(\?|$)/.test(url)) {
      return signedIn
        ? route.fulfill({ status: 200, json: { user: USER } })
        : route.fulfill({ status: 401, json: { error: "not_authenticated" } });
    }
    return route.fulfill({ status: 200, json: {} });
  });
  if (signedIn) {
    await page.addInitScript(() => localStorage.setItem("edgecoder_session_token", "a11y-test-token"));
  }
}

async function audit(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const critical = results.violations.filter((v) => v.impact === "critical");
  const serious = results.violations.filter((v) => v.impact === "serious");
  // Serious issues are reported (visible in the job log and HTML report) but don't fail yet.
  if (serious.length) {
    test.info().annotations.push({ type: "axe-serious", description: serious.map((v) => `${v.id} (${v.nodes.length})`).join(", ") });
  }
  expect(critical.map((v) => `${v.id}: ${v.help} -> ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
}

async function noHorizontalOverflow(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, "page scrolls horizontally").toBeLessThanOrEqual(client + 1);
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test("login screen", async ({ page }) => {
      await stubBackend(page, false);
      await page.goto("/");
      await expect(page.getByRole("button", { name: /sign in/i }).first()).toBeVisible();
      await audit(page);
      await noHorizontalOverflow(page);
    });

    test("app shell (signed in)", async ({ page }) => {
      await stubBackend(page, true);
      await page.goto("/");
      await expect(page.getByRole("button", { name: /sign in/i })).toHaveCount(0, { timeout: 15_000 });
      await page.waitForLoadState("networkidle");
      await audit(page);
      await noHorizontalOverflow(page);
    });
  });
}
