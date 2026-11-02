import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { hashApiKey, hostedTarget, registerHostedRoutes } from "../../src/portal/routes/hosted.js";

describe("hosted endpoint", () => {
  it("reads where to run from the model name", () => {
    expect(hostedTarget("network/qwen3.5:9b@gpu")).toEqual({ model: "qwen3.5:9b", computeClass: "gpu" });
    expect(hostedTarget("qwen3.5:9b")).toEqual({ model: "qwen3.5:9b", computeClass: "any" });
    expect(hostedTarget("mine/qwen2.5-coder:7b")).toEqual({ model: "qwen2.5-coder:7b", target: "mine" });
    expect(hostedTarget("reserved/res-1/qwen2.5-coder:32b")).toEqual({ model: "qwen2.5-coder:32b", reservationId: "res-1" });
    expect(hostedTarget(undefined)).toBeNull();
  });

  const setup = () => {
    const keys = new Map<string, string>();
    const calls: Array<{ path: string; body: unknown }> = [];
    const store = {
      userForApiKeyHash: async (h: string) => keys.get(h) ?? null,
      createApiKey: async (k: { keyHash: string; userId: string }) => void keys.set(k.keyHash, k.userId),
      countApiKeys: async () => keys.size,
      listApiKeys: async () => [],
      revokeApiKey: async () => true,
      setDisplayName: async () => undefined,
    };
    const app = Fastify();
    registerHostedRoutes(app, {
      store: store as never,
      getCurrentUser: async (req) => (req.headers.cookie === "session" ? { userId: "u1" } : null),
      PORTAL_SERVICE_TOKEN: "svc",
      EXTERNAL_HTTP_TIMEOUT_MS: 1000,
      discoverCoordinatorUrlsForPortal: async () => [],
    });
    return { app, keys, calls };
  };

  it("issues a key once, stores only its hash, and accepts it on /v1", async () => {
    const { app, keys } = setup();
    const created = await app.inject({ method: "POST", url: "/portal/api/keys", headers: { cookie: "session" }, payload: { name: "Cursor" } });
    const { key } = created.json();
    expect(key).toMatch(/^eck_/);
    expect([...keys.keys()]).toEqual([hashApiKey(key)]);
    const noKey = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer eck_wrong" }, payload: { model: "network/m", messages: [{ role: "user", content: "x" }] } });
    expect(noKey.statusCode).toBe(401);
    // Valid key, no coordinator reachable: a clear 503 from the network, not an auth error.
    const r = await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": key }, payload: { model: "network/m", max_tokens: 5, messages: [{ role: "user", content: "x" }] } });
    expect(r.statusCode).toBe(502);
    expect(r.json().error.message).toContain("no_coordinator");
  });

  it("needs a signed-in user for keys and profile, and refuses markup in names", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "POST", url: "/portal/api/keys", payload: { name: "x" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/me/profile", headers: { cookie: "session" }, payload: { displayName: "<b>x</b>" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/me/profile", headers: { cookie: "session" }, payload: { displayName: "Cody" } })).json()).toEqual({ ok: true, displayName: "Cody" });
  });
});
