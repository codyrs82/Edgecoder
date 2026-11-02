import { expect, test } from "@playwright/test";

test("ghost text appears after a pause and Tab accepts it", async ({ page }) => {
  await page.goto("/e2e/harness/autocomplete.html");
  await page.waitForFunction(() => (window as any).ready === true);
  await page.locator(".monaco-editor").click();
  await page.keyboard.type("def fib(n):\nif ", { delay: 20 }); // Monaco indents the new line itself
  await expect(page.locator(".ghost-text-decoration, .ghost-text").first()).toBeVisible({ timeout: 5000 });
  const call = await page.evaluate(() => (window as any).calls.at(-1));
  expect(call.prefix).toBe("def fib(n):\n    if ");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => (window as any).editor.getValue())).toBe("def fib(n):\n    if n <= 1:\n        return n");
});

test("typing quickly asks once, after the pause", async ({ page }) => {
  await page.goto("/e2e/harness/autocomplete.html");
  await page.waitForFunction(() => (window as any).ready === true);
  await page.locator(".monaco-editor").click();
  await page.keyboard.type("import os\nprint(os.getcwd())", { delay: 10 });
  await page.waitForTimeout(800);
  const calls = await page.evaluate(() => (window as any).calls.length);
  expect(calls).toBeLessThanOrEqual(2);
});

test("a missing model is reported once, not on every keystroke", async ({ page }) => {
  await page.goto("/e2e/harness/autocomplete.html");
  await page.waitForFunction(() => (window as any).ready === true);
  await page.evaluate(() => { (window as any).mode = "missing"; });
  await page.locator(".monaco-editor").click();
  for (const chunk of ["x = 1", "\ny = 2", "\nz = 3"]) {
    await page.keyboard.type(chunk);
    await page.waitForTimeout(500);
  }
  expect(await page.evaluate(() => (window as any).notices)).toEqual(["install m"]);
});
