// #24: axe audit with the Cmd/Ctrl+K command palette open, in both themes. Critical and serious
// violations (including colour contrast of the selected row and the shortcut hints) fail.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const USER = { userId: "u_a11y", email: "a11y@example.org", displayName: "A11y", emailVerified: true };

/** No backend in CI: stub every request that isn't the preview server; `/me` signs us in. */
async function signedIn(page: Page) {
  await page.route(/^(?!http:\/\/127\.0\.0\.1:4173\/).*/, (route) =>
    /\/me(\?|$)/.test(route.request().url())
      ? route.fulfill({ status: 200, json: { user: USER } })
      : route.fulfill({ status: 200, json: {} }),
  );
  await page.addInitScript(() => localStorage.setItem("edgecoder_session_token", "a11y-test-token"));
}

async function auditPalette(page: Page) {
  const results = await new AxeBuilder({ page })
    .include(".palette")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  const moderate = results.violations.filter((v) => v.impact === "moderate" || v.impact === "minor");
  if (moderate.length) {
    test.info().annotations.push({ type: "axe-moderate", description: moderate.map((v) => `${v.id} (${v.nodes.length})`).join(", ") });
  }
  expect(
    blocking.map((v) => `${v.impact} ${v.id}: ${v.help} -> ${v.nodes.map((n) => `${n.target.join(" ")} [${(n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 160)}]`).join(" | ")}`),
  ).toEqual([]);
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`command palette, ${theme}`, () => {
    test.use({ viewport: { width: 1200, height: 800 } });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("edgecoder-theme", t), theme);
      await signedIn(page);
      await page.goto("/");
      await page.getByRole("button", { name: "Open command palette" }).click();
      await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    });

    test("open, first row selected", async ({ page }) => {
      await expect(page.locator(".palette-item[data-selected]")).toHaveCount(1);
      await auditPalette(page);
    });

    test("selection moved with the arrow keys", async ({ page }) => {
      const first = await page.locator(".palette-item[data-selected]").textContent();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await expect(page.locator(".palette-item[data-selected]")).not.toHaveText(first ?? "");
      // Any <kbd> shortcut hints in the list are covered by the colour-contrast rule here.
      await auditPalette(page);
    });

    test("filtered to no results", async ({ page }) => {
      await page.keyboard.type("zzzz-no-such-command");
      await expect(page.getByText("No matching commands")).toBeVisible();
      await auditPalette(page);
    });
  });
}
