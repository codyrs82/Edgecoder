import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { expect, test } from "@playwright/test";

// The webview calls the IDE server cross-origin. A stream that drops the CORS headers fails in
// the app ("Load failed") while curl works, so this reads one from a page on another origin.
test("an agent turn streams to a page on another origin", async ({ page }) => {
  const token = readFileSync(join(homedir(), ".edgecoder", "ide-token"), "utf8").trim();
  const project = mkdtempSync(join(tmpdir(), "e2e-proj-"));
  await page.goto("/e2e/harness/blank.html");
  const result = await page.evaluate(async ([tok, root]) => {
    const base = "http://127.0.0.1:4324";
    const h = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
    const set = await fetch(`${base}/v1/ide/project`, { method: "POST", headers: h, body: JSON.stringify({ projectRoot: root }) });
    const res = await fetch(`${base}/v1/ide/chat`, { method: "POST", headers: h, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
    const text = await res.text();
    return { set: set.status, status: res.status, types: [...text.matchAll(/"type":"(\w+)"/g)].map((m) => m[1]) };
  }, [token, project] as const);
  expect(result.set).toBe(200);
  expect(result.status).toBe(200);
  expect(result.types[0]).toBe("turn");
  expect(result.types.at(-1)).toBe("done");
});
