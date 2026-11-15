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

/** A raw HTTP/1.1 request (fetch would normalise the target), returning the status line. */
async function rawStatus(target: string, host?: string): Promise<string> {
  const { connect } = await import("node:net");
  const port = (srv.server.address() as { port: number }).port;
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: ${host ?? `127.0.0.1:${port}`}\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("end", () => resolve(data.split("\r\n")[0]));
    sock.on("error", reject);
  });
}

describe("preview server request parsing", () => {
  it("answers malformed request targets instead of crashing the process", async () => {
    expect(await rawStatus("//")).toMatch(/ 404 /);
    expect(await rawStatus(`/p/${"k".repeat(32)}/%E0%A4%A`)).toMatch(/ 400 /);
    // Still serving afterwards.
    expect((await fetch(base)).status).toBe(200);
  });

  it("refuses a non-loopback Host (DNS rebinding)", async () => {
    expect(await rawStatus(`/p/${"k".repeat(32)}/`, "attacker.example")).toMatch(/ 403 /);
    expect(await rawStatus(`/p/${"k".repeat(32)}/`)).toMatch(/ 200 /);
  });
});
