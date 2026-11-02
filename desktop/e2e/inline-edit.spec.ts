import { expect, test, type Page } from "@playwright/test";

// Cmd+K inline edit (src/lib/inline-edit-session.ts) with a canned model reply.
async function open(page: Page, value: string, reply: string) {
  await page.goto("/e2e/harness/inline-edit.html");
  await page.waitForFunction(() => (window as any).ready === true);
  await page.evaluate(([v, r]) => {
    const w = window as any;
    w.editor.setValue(v);
    w.reply = r;
  }, [value, reply]);
}
const val = (page: Page) => page.evaluate(() => (window as any).editor.getValue() as string);

async function cmdK(page: Page, instruction: string) {
  await page.keyboard.press("Meta+k");
  await page.locator(".ec-ie-box input").waitFor();
  await page.keyboard.type(instruction);
  await page.keyboard.press("Enter");
  await page.locator(".ec-ie-hunk").first().waitFor();
}

test("each change can be kept or undone, then the rest accepted", async ({ page }) => {
  await open(page, "def f(x):\n    return x\n\ndef g(y):\n    return y\n\nprint(f(1))\n", "def f(x):\n    return 2 * x\n\ndef g(y):\n    return y + 1\n");
  await page.evaluate(() => { const e = (window as any).editor; e.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 6, endColumn: 1 }); e.focus(); });
  await cmdK(page, "double f, increment g");

  const req = await page.evaluate(() => (window as any).requests[0]);
  expect(req.selection).toBe("def f(x):\n    return x\n\ndef g(y):\n    return y\n");
  expect(req.suffix).toBe("\nprint(f(1))\n");
  expect(await page.locator(".ec-ie-hunk").count()).toBe(2);
  expect(await page.locator(".ec-ie-removed div").allTextContents()).toEqual(["    return x", "    return y"]);
  // The submitting Enter is not typed into the code.
  expect(await val(page)).toBe("def f(x):\n    return 2 * x\n\ndef g(y):\n    return y + 1\n\nprint(f(1))\n");

  await page.locator(".ec-ie-hunk button.no").first().click();
  expect(await val(page)).toBe("def f(x):\n    return x\n\ndef g(y):\n    return y + 1\n\nprint(f(1))\n");

  await page.evaluate(() => (window as any).editor.focus());
  await page.keyboard.press("Meta+Enter");
  expect(await val(page)).toBe("def f(x):\n    return x\n\ndef g(y):\n    return y + 1\n\nprint(f(1))\n");
  await expect(page.locator(".ec-ie-hunk, .ec-ie-box, .ec-ie-removed")).toHaveCount(0);
});

test("Esc rejects everything", async ({ page }) => {
  await open(page, "def f(x):\n    return x\n\nprint(f(1))\n", "def f(x: int) -> int:\n    return 2 * x\n");
  await page.evaluate(() => { const e = (window as any).editor; e.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1 }); e.focus(); });
  await cmdK(page, "types");
  await page.evaluate(() => (window as any).editor.focus());
  await page.keyboard.press("Escape");
  expect(await val(page)).toBe("def f(x):\n    return x\n\nprint(f(1))\n");
  await expect(page.locator(".ec-ie-hunk, .ec-ie-box, .ec-ie-removed")).toHaveCount(0);
});

test("with no selection, code is inserted below the cursor line, even at the end of the file", async ({ page }) => {
  await open(page, "a = 1", "b = 2");
  await page.evaluate(() => { const e = (window as any).editor; e.setPosition({ lineNumber: 1, column: 3 }); e.focus(); });
  await cmdK(page, "add b");
  expect(await val(page)).toBe("a = 1\nb = 2");
  await page.locator(".ec-ie-hunk button.no").first().click();
  expect(await val(page)).toBe("a = 1");
});
