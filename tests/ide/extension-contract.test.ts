import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDE_ROUTES } from "../../src/apps/ide/routes.js";

const TOKEN = "contract-test-token";
process.env.IDE_PROVIDER_TOKEN = TOKEN;
delete process.env.IDE_PROVIDER_HOST;
delete process.env.MESH_AUTH_TOKEN;

const { ideProviderServer: app } = await import("../../src/apps/ide/provider-server.js");
const headers = { host: "127.0.0.1:4304", authorization: `Bearer ${TOKEN}` };

/** Every (method, path) the VS Code extension calls. */
function extensionCalls(): Array<{ method: "GET" | "POST"; path: string }> {
  const src = readFileSync(new URL("../../extensions/vscode/src/extension.ts", import.meta.url), "utf8");
  const calls: Array<{ method: "GET" | "POST"; path: string }> = [];
  for (const m of src.matchAll(/getJson\(\s*`\$\{baseUrl\}(\/[^`]*)`/g)) calls.push({ method: "GET", path: m[1] });
  for (const m of src.matchAll(/postJson\(\s*`\$\{baseUrl\}(\/[^`$]*)`/g)) calls.push({ method: "POST", path: m[1] });
  // runEdgeCoder(context, "/run…") feeds postJson(`${baseUrl}${endpoint}`)
  for (const m of src.matchAll(/runEdgeCoder\(\s*context\s*,\s*"(\/[^"]+)"/g)) calls.push({ method: "POST", path: m[1] });
  return calls;
}

describe("IDE extension ↔ provider server contract (#36)", () => {
  beforeAll(async () => {
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("finds the extension's calls", () => {
    const calls = extensionCalls();
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: "GET", path: "/health" },
        { method: "GET", path: "/status" },
        { method: "POST", path: "/run" },
        { method: "POST", path: "/run/local" },
        { method: "POST", path: "/run/swarm" }
      ])
    );
  });

  it("every extension call is in IDE_ROUTES and served by the server", () => {
    for (const c of extensionCalls()) {
      expect(IDE_ROUTES.some((r) => r.method === c.method && r.path === c.path), `${c.method} ${c.path} in IDE_ROUTES`).toBe(true);
      expect(app.hasRoute({ method: c.method, url: c.path }), `${c.method} ${c.path} served`).toBe(true);
    }
  });

  it("every IDE_ROUTES entry is served", () => {
    for (const r of IDE_ROUTES) expect(app.hasRoute({ method: r.method, url: r.path }), `${r.method} ${r.path}`).toBe(true);
  });

  it("GET /health → 200 {ok:true} without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "127.0.0.1:4304" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("GET /status → 200 router status", async () => {
    const res = await app.inject({ method: "GET", url: "/status", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("swarmEnabled", false);
  });

  it("POST /run/local returns route + latencyMs + RunResult fields (stub provider)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/run/local",
      headers,
      payload: { task: "Print hello", language: "python", maxTokens: 1024 }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.route).toBe("edgecoder-local");
    expect(typeof body.latencyMs).toBe("number");
    expect(typeof body.plan).toBe("string");
    expect(typeof body.generatedCode).toBe("string");
    expect(body.runResult).toHaveProperty("exitCode");
  }, 30_000);

  it("POST /run/swarm without mesh config → 503 swarm_unavailable", async () => {
    const res = await app.inject({ method: "POST", url: "/run/swarm", headers, payload: { task: "x", language: "python" } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("swarm_unavailable");
  });

  it("POST /run with an invalid body → 400", async () => {
    const res = await app.inject({ method: "POST", url: "/run", headers, payload: {} });
    expect(res.statusCode).toBe(400);
  });
});
