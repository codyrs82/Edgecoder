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
  // Critical and serious both fail (serious includes WCAG AA colour contrast, 4.5:1 text / 3:1 UI).
  const blocking = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  const moderate = results.violations.filter((v) => v.impact === "moderate" || v.impact === "minor");
  if (moderate.length) {
    test.info().annotations.push({ type: "axe-moderate", description: moderate.map((v) => `${v.id} (${v.nodes.length})`).join(", ") });
  }
  expect(
    blocking.map((v) => `${v.impact} ${v.id}: ${v.help} -> ${v.nodes.map((n) => `${n.target.join(" ")} [${(n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 160)}]`).join(" | ")}`)
  ).toEqual([]);
}

async function noHorizontalOverflow(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, "page scrolls horizontally").toBeLessThanOrEqual(client + 1);
}

for (const theme of ["dark", "light"] as const)
for (const vp of VIEWPORTS) {
  test.describe(`${theme} ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("edgecoder-theme", t), theme);
    });

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

    // #161: a conversation row with its menu open; keyboard focus goes in and comes back.
    test("conversation menu (signed in)", async ({ page }) => {
      await stubBackend(page, true);
      await seedConversation(page);
      await page.goto("/");
      const trigger = page.getByRole("button", { name: `More options for ${SEEDED_TITLE}` });
      await expect(trigger).toBeAttached({ timeout: 15_000 });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const items = page.getByRole("menu").getByRole("menuitem");
      await expect(items.first()).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(items.nth(1)).toBeFocused();
      // Let the menu's open animation finish, or axe measures half-faded colours.
      await page.getByRole("menu").evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
      await audit(page);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  });
}

const SEEDED_TITLE = "Seeded a11y chat";

/** Put one chat conversation in the app's IndexedDB store (src/lib/chat-store.ts) before load. */
async function seedConversation(page: Page) {
  await page.addInitScript((title) => {
    const req = indexedDB.open("edgecoder-chat", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("conversations", { keyPath: "id" });
    req.onsuccess = () => {
      const now = Date.now();
      const tx = req.result.transaction("conversations", "readwrite");
      tx.objectStore("conversations").put({ id: "a11y-seed", title, messages: [], createdAt: now, updatedAt: now, source: "chat" });
      tx.oncomplete = () => req.result.close();
    };
  }, SEEDED_TITLE);
}
