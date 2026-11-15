// #29: no critical or serious axe violations on any screen or overlay, in both themes, and no
// horizontal overflow at the smallest window size.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { fixtureFor, NOT_FOUND, SECTION_SHOWS } from "./fixtures";

// The Tauri window's minimum is 640x480 (desktop/src-tauri/tauri.conf.json); 1200x800 is the default.
const VIEWPORTS = [
  { width: 640, height: 480 },
  { width: 1200, height: 800 },
];

const USER = { userId: "u_a11y", email: "a11y@example.org", displayName: "A11y", emailVerified: true };

/**
 * No real backend in CI: the app runs outside Tauri, so every request that isn't the preview
 * server itself is answered from a11y/fixtures.ts. `/me` decides whether we land on the login
 * screen or the app shell.
 */
async function stubBackend(page: Page, signedIn: boolean) {
  await page.route(/^(?!http:\/\/127\.0\.0\.1:4173\/).*/, async (route) => {
    const url = route.request().url();
    if (/\/me(\?|$)/.test(url)) {
      return signedIn
        ? route.fulfill({ status: 200, json: { user: USER } })
        : route.fulfill({ status: 401, json: { error: "not_authenticated" } });
    }
    const body = route.request().method() === "GET" ? fixtureFor(url) : {};
    if (body === NOT_FOUND) return route.fulfill({ status: 404, json: { error: "not_found" } });
    return route.fulfill({ status: 200, json: body });
  });
  if (signedIn) {
    await page.addInitScript(() => localStorage.setItem("edgecoder_session_token", "a11y-test-token"));
  }
}

async function audit(page: Page, where = "") {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  // Critical and serious both fail (serious includes WCAG AA colour contrast, 4.5:1 text / 3:1 UI).
  const blocking = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  const moderate = results.violations.filter((v) => v.impact === "moderate" || v.impact === "minor");
  if (moderate.length) {
    test.info().annotations.push({ type: "axe-moderate", description: moderate.map((v) => `${v.id} (${v.nodes.length})`).join(", ") });
  }
  // Soft, so one run reports every screen's findings instead of stopping at the first.
  expect.soft(
    blocking.map((v) => `${v.impact} ${v.id}: ${v.help} -> ${v.nodes.map((n) => `${n.target.join(" ")} [${(n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 160)}]`).join(" | ")}`),
    where
  ).toEqual([]);
}

async function openApp(page: Page) {
  await stubBackend(page, true);
  await page.goto("/");
  await expect(page.getByRole("button", { name: /sign in/i })).toHaveCount(0, { timeout: 15_000 });
  await page.waitForLoadState("networkidle");
}

/** Let open animations finish, or axe measures half-faded colours. Spinners never finish, so they are skipped. */
async function settle(target: Locator) {
  await target.first().evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

/** The element's own content does not spill sideways (a scroll container hides it from the page check). */
async function fitsInside(target: Locator, where = "") {
  const spill = await target.evaluate((el) => {
    if (el.scrollWidth <= el.clientWidth + 1) return [];
    // Name what sticks out, so a failure points at the rule to fix.
    const right = el.getBoundingClientRect().right;
    return Array.from(el.querySelectorAll<HTMLElement>("*"))
      .filter((c) => c.getBoundingClientRect().right > right + 1 && !Array.from(c.children).some((k) => k.getBoundingClientRect().right > right + 1))
      .slice(0, 5)
      .map((c) => `${c.tagName.toLowerCase()}.${c.className} "${(c.textContent ?? "").trim().slice(0, 30)}"`);
  });
  expect.soft(spill, `${where} scrolls horizontally`).toEqual([]);
}

async function insideViewport(target: Locator, page: Page) {
  const box = await target.boundingBox();
  const vp = page.viewportSize()!;
  expect(box, "not rendered").not.toBeNull();
  expect(box!.x, "cut off on the left").toBeGreaterThanOrEqual(0);
  expect(box!.y, "cut off at the top").toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, "cut off on the right").toBeLessThanOrEqual(vp.width + 1);
  expect(box!.y + box!.height, "cut off at the bottom").toBeLessThanOrEqual(vp.height + 1);
}

async function noHorizontalOverflow(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect.soft(scroll, "page scrolls horizontally").toBeLessThanOrEqual(client + 1);
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

    // #24: the header's + menu uses the same keyboard menu.
    test("new menu", async ({ page }) => {
      await openApp(page);
      const trigger = page.getByRole("button", { name: "New", exact: true });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const items = page.getByRole("menu", { name: "New" }).getByRole("menuitem");
      await expect(items.first()).toBeFocused();
      await page.keyboard.press("End");
      await expect(items.last()).toBeFocused();
      await settle(page.getByRole("menu"));
      await audit(page);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });

    // #24/#26: Settings is a modal dialog of vertical tabs; every section is audited.
    test("settings: every section", async ({ page }) => {
      test.setTimeout(180_000);
      await openApp(page);
      const opener = page.getByRole("banner").getByRole("button", { name: "Settings" });
      await opener.click();
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog).toBeVisible();
      const tabs = dialog.getByRole("tablist", { name: "Settings sections" }).getByRole("tab");
      await expect(tabs.first()).toBeFocused();
      const count = await tabs.count();
      expect(count).toBe(13);
      for (let i = 0; i < count; i++) {
        const tab = tabs.nth(i);
        const name = (await tab.textContent())?.trim() ?? String(i);
        await test.step(name, async () => {
          await tab.click();
          await expect(tab).toHaveAttribute("aria-selected", "true");
          await page.waitForLoadState("networkidle");
          // Sections draw placeholders or an empty state first (Models waits about a second for
          // the shell's token before it asks for anything); audit what replaces them.
          await expect(dialog.locator(".skeleton-line")).toHaveCount(0, { timeout: 10_000 });
          expect(SECTION_SHOWS[name], `no loaded-state text listed for ${name}`).toBeTruthy();
          await expect(dialog.getByRole("tabpanel")).toContainText(SECTION_SHOWS[name], { timeout: 10_000 });
          await settle(dialog);
          await audit(page, name);
          await noHorizontalOverflow(page);
          await fitsInside(dialog.getByRole("tabpanel"), name);
        });
      }
      // Arrow keys move through the tablist and Escape hands focus back to the opener.
      await tabs.first().focus();
      await page.keyboard.press("ArrowDown");
      await expect(tabs.nth(1)).toBeFocused();
      await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
    });

    // #24: saving settings raises a toast, which must stay usable above the open dialog.
    test("toast over settings", async ({ page }) => {
      await openApp(page);
      await page.getByRole("banner").getByRole("button", { name: "Settings" }).click();
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await dialog.getByRole("button", { name: "Save Settings" }).click();
      const toast = page.getByText("Settings saved");
      await expect(toast).toBeVisible();
      await settle(page.locator("[data-sonner-toaster]"));
      await audit(page);
      await expect(dialog).toBeVisible();
    });

    // #26: the model picker is a popup with a search field driving a listbox.
    test("compute picker", async ({ page }) => {
      await openApp(page);
      const trigger = page.getByRole("button", { name: /Choose the model|Auto|model/i }).first();
      await trigger.click();
      const popup = page.getByRole("dialog", { name: "Model and compute" });
      await expect(popup).toBeVisible();
      await expect(popup.getByRole("combobox", { name: "Search models" })).toBeFocused();
      await settle(popup);
      await audit(page);
      await noHorizontalOverflow(page);
      await insideViewport(popup, page);
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });

    // #24: a dialog holding selects and a nested popup; each layer closes on its own Escape.
    test("bot form", async ({ page }) => {
      await openApp(page);
      await page.getByRole("button", { name: "New", exact: true }).click();
      await page.getByRole("menuitem", { name: "New bot" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await settle(dialog);
      await audit(page);
      await noHorizontalOverflow(page);
      await insideViewport(dialog, page);
      const schedule = dialog.getByRole("combobox", { name: "Schedule" });
      await schedule.scrollIntoViewIfNeeded();
      await schedule.click();
      const list = page.getByRole("listbox");
      await expect(list).toBeVisible();
      await settle(list);
      await audit(page);
      await insideViewport(list, page);
      const second = list.getByRole("option").nth(1);
      const label = (await second.textContent())?.trim() ?? "";
      await second.click();
      await expect(list).toHaveCount(0);
      await expect(schedule).toContainText(label);
      await schedule.focus();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("listbox")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(dialog).toBeVisible();
    });

    test("editor view", async ({ page }) => {
      await openApp(page);
      const tab = page.getByRole("tab", { name: "Code" });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#view-editor")).toBeVisible();
      await page.waitForLoadState("networkidle");
      await audit(page);
      await noHorizontalOverflow(page);
      // The panes clip their overflow, so the page check cannot see a chat panel pushed off the edge.
      await insideViewport(page.locator("#view-editor").getByRole("textbox").last(), page);
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
