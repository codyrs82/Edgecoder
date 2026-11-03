import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerHostedRoutes } from "../../../src/portal/routes/hosted.js";
import { DEFAULT_PORTAL_URL as INSTALLER_DEFAULT } from "../../../src/install/options.js";
import { fakeStore } from "../../../tests/portal/fake-agent-store.js";
import { baseUrlFrom, DEFAULT_PORTAL_URL, type Http } from "../src/http.js";
import { apiKeySource, loadOrCreateAgentKey } from "../src/identity.js";
import { authedHttp, makeHandlers, toolShapes } from "../src/tools.js";

type Call = { method: string; path: string; body?: any; apiKey?: string };

/** A fake HTTP layer: records calls and answers from a table keyed by "METHOD path". */
function fakeHttp(routes: Record<string, (c: Call) => { status: number; json: any }>) {
  const calls: Call[] = [];
  const http: Http = async (method, path, body, apiKey) => {
    const c = { method, path, body, apiKey };
    calls.push(c);
    const h = routes[`${method} ${path}`];
    return h ? h(c) : { status: 404, json: { error: "not_found" } };
  };
  return { http, calls };
}
const fixedKey = (k = "eck_test") => ({ current: async () => k });
const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("\n");

describe("MCP tools", () => {
  it("defines every tool the roadmap names", () => {
    expect(Object.keys(toolShapes).sort()).toEqual(
      ["balance", "cancel_reservation", "chat", "list_models", "list_reservations", "reserve_machine", "topup", "topup_status", "usage"].sort(),
    );
  });

  it("list_models includes auto", async () => {
    const { http } = fakeHttp({ "GET /v1/models": () => ({ status: 200, json: { data: [{ id: "auto" }, { id: "network/qwen3.5:9b" }] } }) });
    const r = await makeHandlers(authedHttp(http, fixedKey())).list_models({});
    expect(r.structuredContent).toEqual({ models: ["auto", "network/qwen3.5:9b"] });
  });

  it("chat defaults to auto and returns text, cSats and where", async () => {
    const { http, calls } = fakeHttp({
      "POST /v1/chat/completions": () => ({
        status: 200,
        json: { model: "auto", choices: [{ message: { content: "4" } }], usage: { total_tokens: 9 }, edgecoder: { cSatsSpent: 0.8, where: "network · qwen3.5:9b · GPU" } },
      }),
    });
    const r = await makeHandlers(authedHttp(http, fixedKey())).chat({ prompt: "2+2?", system: "Be brief." });
    expect(calls[0].body).toMatchObject({ model: "auto", stream: false, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "2+2?" }] });
    expect(calls[0].apiKey).toBe("eck_test");
    expect(r.structuredContent).toMatchObject({ text: "4", cSats: 0.8, where: "network · qwen3.5:9b · GPU" });
    expect(text(r)).toContain("0.8 cSats");
    expect((await makeHandlers(authedHttp(http, fixedKey())).chat({})).isError).toBe(true);
  });

  it("a 402 explains how to top up", async () => {
    const { http } = fakeHttp({ "POST /v1/chat/completions": () => ({ status: 402, json: { error: { message: "insufficient_balance" } } }) });
    const r = await makeHandlers(authedHttp(http, fixedKey())).chat({ prompt: "hi" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/topup/);
  });

  it("topup returns the bolt11 invoice and amount; status and balance read the account", async () => {
    const { http, calls } = fakeHttp({
      "POST /v1/account/topup": () => ({ status: 200, json: { intentId: "int-1", invoice: "lnbc10u1xyz", amountSats: 1000, cSats: 1000, feeSats: 0, network: "bitcoin", expiresInSeconds: 900 } }),
      "GET /v1/account/topup/int-1": () => ({ status: 200, json: { intentId: "int-1", status: "settled" } }),
      "GET /v1/account": () => ({ status: 200, json: { accountId: "acct-a", cSats: 12, recent: [] } }),
      "GET /v1/account/usage?days=7": () => ({ status: 200, json: { totals: { requests: 1 }, byDay: [], byModel: [], records: [] } }),
    });
    const h = makeHandlers(authedHttp(http, fixedKey()));
    const t = await h.topup({ amountSats: 1000 });
    expect(t.structuredContent).toMatchObject({ invoice: "lnbc10u1xyz", amountSats: 1000, intentId: "int-1" });
    expect(text(t)).toContain("lnbc10u1xyz");
    expect(calls[0].body).toEqual({ amountSats: 1000 });
    expect((await h.topup_status({ intentId: "int-1" })).structuredContent).toMatchObject({ status: "settled" });
    expect((await h.balance({})).structuredContent).toMatchObject({ accountId: "acct-a", cSats: 12 });
    expect((await h.usage({ days: 7 })).structuredContent).toMatchObject({ totals: { requests: 1 } });
  });

  it("reservations: reserve, list, cancel", async () => {
    const { http, calls } = fakeHttp({
      "POST /v1/account/reservations": () => ({ status: 200, json: { reservation: { id: "res-1" } } }),
      "GET /v1/account/reservations": () => ({ status: 200, json: { reservations: [{ id: "res-1" }] } }),
      "POST /v1/account/reservations/cancel": () => ({ status: 200, json: { ok: true } }),
    });
    const h = makeHandlers(authedHttp(http, fixedKey()));
    expect((await h.reserve_machine({ computeClass: "gpu", minutes: 30 })).structuredContent).toMatchObject({ reservation: { id: "res-1" } });
    expect(calls[0].body).toEqual({ computeClass: "gpu", minutes: 30 });
    expect((await h.list_reservations({})).structuredContent).toMatchObject({ reservations: [{ id: "res-1" }] });
    expect((await h.cancel_reservation({ reservationId: "res-1" })).structuredContent).toEqual({ ok: true });
  });

  it("renews the key once on 401 and retries", async () => {
    let valid = "eck_old";
    const { http, calls } = fakeHttp({ "GET /v1/account": (c) => (c.apiKey === valid ? { status: 200, json: { accountId: "a", cSats: 1 } } : { status: 401, json: { error: "bad key" } }) });
    valid = "eck_new";
    const r = await makeHandlers(authedHttp(http, { current: async () => "eck_old", renew: async () => "eck_new" })).balance({});
    expect(r.isError).toBeUndefined();
    expect(calls.map((c) => c.apiKey)).toEqual(["eck_old", "eck_new"]);
  });
});

describe("MCP identity and config", () => {
  it("defaults to the installer's portal URL and refuses plain http to remote hosts", () => {
    expect(DEFAULT_PORTAL_URL).toBe(INSTALLER_DEFAULT);
    expect(baseUrlFrom({})).toBe(INSTALLER_DEFAULT);
    expect(baseUrlFrom({ EDGECODER_URL: "https://portal.example.org/" })).toBe("https://portal.example.org");
    expect(baseUrlFrom({ EDGECODER_URL: "http://localhost:4310" })).toBe("http://localhost:4310");
    expect(() => baseUrlFrom({ EDGECODER_URL: "http://portal.example.org" })).toThrow(/https/);
  });

  it("signs up against the real portal routes with a generated key, stores it 0600, and rotates on 401", async () => {
    const store = fakeStore();
    const app = Fastify();
    registerHostedRoutes(app, { store: store as never, getCurrentUser: async () => null, PORTAL_SERVICE_TOKEN: "svc", EXTERNAL_HTTP_TIMEOUT_MS: 1000, discoverCoordinatorUrlsForPortal: async () => [] });
    const http: Http = async (method, path, body, apiKey) => {
      const r = await app.inject({ method, url: path, payload: body as never, headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
      return { status: r.statusCode, json: r.json() };
    };
    const keyPath = join(mkdtempSync(join(tmpdir(), "ec-mcp-")), "sub", "agent-key");
    const src = apiKeySource({ http, url: "http://localhost", keyPath, name: "Test agent" });
    const apiKey = await src.current();
    expect(apiKey).toMatch(/^eck_/);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(keyPath, "utf8"));
    expect(saved).toMatchObject({ keyType: "secp256k1", apiKey, url: "http://localhost" });
    expect(loadOrCreateAgentKey(keyPath).publicKey).toBe(saved.publicKey);
    // The models tool works with that key.
    const tools = makeHandlers(authedHttp(http, src));
    expect((await tools.list_models({})).structuredContent).toEqual({ models: ["auto"] });
    // Revoke the key behind its back: the next call signs up again (same account, new key).
    await store.revokeAllApiKeys(saved.accountId.replace(/^acct-/, ""));
    expect((await tools.list_models({})).isError).toBeUndefined();
    const after = JSON.parse(readFileSync(keyPath, "utf8"));
    expect(after.accountId).toBe(saved.accountId);
    expect(after.apiKey).not.toBe(apiKey);
    // A fresh process reuses the stored key without signing up.
    const reused = apiKeySource({ http, url: "http://localhost", keyPath });
    expect(await reused.current()).toBe(after.apiKey);
    // EDGECODER_API_KEY wins and is never renewed.
    expect(apiKeySource({ http, url: "x", keyPath, envKey: "eck_env" }).renew).toBeUndefined();
  });
});
