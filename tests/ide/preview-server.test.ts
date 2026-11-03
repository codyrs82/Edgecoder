import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPreviewServer } from "../../src/apps/ide/preview-server.js";

let root: string;
let outside: string;
let base: string;
let wrongKeyBase: string;
const preview = { root: null as string | null };
const srv = createPreviewServer(() => preview.root, "k".repeat(32));

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "prev-"));
  outside = mkdtempSync(join(tmpdir(), "prev-out-"));
  writeFileSync(join(root, "index.html"), "<h1>hi</h1>");
  mkdirSync(join(root, "css"));
  writeFileSync(join(root, "css", "site.css"), "h1{color:red}");
  writeFileSync(join(outside, "secret.txt"), "nope");
  preview.root = root;
  await new Promise<void>((r) => srv.server.listen(0, "127.0.0.1", r));
  const port = (srv.server.address() as { port: number }).port;
  base = srv.urlFor(port);
  wrongKeyBase = `http://127.0.0.1:${port}/p/${"x".repeat(32)}/`;
});
afterAll(() => {
  srv.server.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("preview server", () => {
  it("serves index.html for the root and files with their types", async () => {
    const r = await fetch(base);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors tauri://localhost");
    expect(await r.text()).toBe("<h1>hi</h1>");
    expect((await fetch(`${base}css/site.css`)).headers.get("content-type")).toContain("text/css");
  });

  it("needs the key, stays in the project, and only reads", async () => {
    expect((await fetch(wrongKeyBase)).status).toBe(404);
    expect((await fetch(`${base}..%2F${outside.split("/").pop()}%2Fsecret.txt`)).status).toBe(404);
    expect((await fetch(`${base}missing.html`)).status).toBe(404);
    expect((await fetch(base, { method: "POST" })).status).toBe(405);
  });
});
