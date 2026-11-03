import { expect, test } from "@playwright/test";

test("@ offers project files; Enter picks one instead of sending", async ({ page }) => {
  await page.goto("/e2e/harness/chat-input.html");
  await page.waitForFunction(() => (window as any).ready === true);
  const box = page.locator("textarea");
  await box.click();
  await page.keyboard.type("explain @api");
  await expect(page.locator(".mentions button")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("explain @src/lib/api.ts ");
  expect(await page.evaluate(() => (window as any).sent)).toEqual([]);

  await page.keyboard.type("and @lib");
  await expect(page.locator(".mentions button")).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(box).toHaveValue("explain @src/lib/api.ts and @src/lib/ ");
  await page.keyboard.type("please");
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as any).sent)).toEqual(["explain @src/lib/api.ts and @src/lib/ please"]);
});

test("Escape closes the picker without sending", async ({ page }) => {
  await page.goto("/e2e/harness/chat-input.html");
  await page.waitForFunction(() => (window as any).ready === true);
  await page.locator("textarea").click();
  await page.keyboard.type("@src");
  await expect(page.locator(".mentions button")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(page.locator(".mentions")).toHaveCount(0);
});
