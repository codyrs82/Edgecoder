import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionManager } from "../../src/apps/ide/connections.js";

let mgr: ConnectionManager | undefined;
afterEach(async () => {
  await mgr?.stopAll();
});

describe("connections", () => {
  it("serves each connection on its own port with its own key, and saves them privately", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "conn-")), "connections.json");
    mgr = new ConnectionManager({ ollamaHost: "http://127.0.0.1:9", file });
    const a = await mgr.create({ name: "Local coder", target: "local", model: "qwen2.5-coder:7b", port: 4391 });
    const b = await mgr.create({ name: "Second", target: "local", model: "qwen3.5:9b", port: 4392 });
    expect(a.listening && b.listening).toBe(true);
    const ok = await request("http://127.0.0.1:4391/v1/models", { headers: { authorization: `Bearer ${a.key}` } });
    expect(((await ok.body.json()) as { data: Array<{ id: string }> }).data[0].id).toBe("qwen2.5-coder:7b");
    const wrongKey = await request("http://127.0.0.1:4392/v1/models", { headers: { authorization: `Bearer ${a.key}` } });
    expect(wrongKey.statusCode).toBe(401);
    await wrongKey.body.text();
    // Ollama isn't there: a clear error, as an HTTP status.
    const chat = await request("http://127.0.0.1:4391/v1/messages", { method: "POST", headers: { "x-api-key": a.key, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }) });
    expect(chat.statusCode).toBe(503);
    expect(((await chat.body.json()) as { error: { message: string } }).error.message).toContain("Ollama isn't running");
    // Windows has no Unix permission bits.
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).connections).toHaveLength(2);
  });

  it("refuses a port another connection or EdgeCoder uses, and network targets without an agent", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "conn-")), "connections.json");
    mgr = new ConnectionManager({ ollamaHost: "http://127.0.0.1:9", file });
    await mgr.create({ name: "A", target: "local", model: "m", port: 4393 });
    await expect(mgr.create({ name: "B", target: "local", model: "m", port: 4393 })).rejects.toThrow(/used by another connection/);
    await expect(mgr.create({ name: "C", target: "local", model: "m", port: 4304 })).rejects.toThrow(/doesn't already use/);
    await expect(mgr.create({ name: "D", target: "network", model: "m" })).rejects.toThrow(/isn't connected/);
    expect(mgr.nextPort()).toBe(4311);
  });

  it("keeps the portal's port 4310 free for new connections but lets a saved one keep it", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "conn-")), "connections.json");
    const saved = { id: "old43100", name: "Old", port: 4310, key: "ec-old", target: "local", model: "m", spentCSats: 0, enabled: false, createdAtMs: 1 };
    writeFileSync(file, JSON.stringify({ connections: [saved] }));
    mgr = new ConnectionManager({ ollamaHost: "http://127.0.0.1:9", file });
    mgr.load();
    expect(mgr.nextPort()).toBe(4311);
    await expect(mgr.create({ name: "New", target: "local", model: "m", port: 4310, enabled: false })).rejects.toThrow(/doesn't already use/);
    const renamed = await mgr.update("old43100", { name: "Renamed" });
    expect(renamed.port).toBe(4310);
    expect(renamed.name).toBe("Renamed");
  });

  it("stops at its budget", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "conn-")), "connections.json");
    mgr = new ConnectionManager({ ollamaHost: "http://127.0.0.1:9", file });
    const c = await mgr.create({ name: "Capped", target: "local", model: "m", port: 4394, budgetCSats: 1 });
    mgr.get(c.id)!.spentCSats = 1;
    const r = await request("http://127.0.0.1:4394/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${c.key}`, "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) });
    expect(r.statusCode).toBe(402);
    await r.body.text();
  });
});
