import { afterAll, beforeAll, describe, expect, it } from "vitest";

// #77: CORS for the packaged desktop app on the IDE provider server.
const TOKEN = "test-ide-cors-token-0123456789abcdef";
process.env.IDE_PROVIDER_TOKEN = TOKEN;
delete process.env.IDE_PROVIDER_HOST;
delete process.env.IDE_ALLOWED_ORIGINS;

const { ideProviderServer: app } = await import("../../src/apps/ide/provider-server.js");
const HOST = "127.0.0.1:4304";
const preflight = (origin: string, url = "/v1/ide/chat") =>
  app.inject({
    method: "OPTIONS",
    url,
    headers: {
      host: HOST,
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });

describe("IDE provider server CORS (#77)", () => {
  beforeAll(async () => {
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  for (const origin of ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]) {
    it(`preflight from ${origin} succeeds without a token and allows Authorization`, async () => {
      const res = await preflight(origin);
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain("authorization");
      expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain("content-type");
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    });
  }

  it("preflight from a web origin is rejected (403) with no CORS headers", async () => {
    const res = await preflight("https://evil.example");
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("preflight with a foreign Host is rejected (DNS rebinding)", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v1/ide/chat",
      headers: { host: "evil.example:4304", origin: "tauri://localhost", "access-control-request-method": "POST" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("an actual request from an allowed origin still needs the token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/ide/project", headers: { host: HOST, origin: "tauri://localhost" } });
    expect(res.statusCode).toBe(401);
  });

  it("an authenticated request from an allowed origin gets Access-Control-Allow-Origin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/ide/project",
      headers: { host: HOST, origin: "tauri://localhost", authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("tauri://localhost");
  });

  it("no wildcard: a request without an allowed origin gets no ACAO", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("an OPTIONS request that isn't a preflight still needs the token", async () => {
    const res = await app.inject({ method: "OPTIONS", url: "/v1/ide/chat", headers: { host: HOST, origin: "tauri://localhost" } });
    expect(res.statusCode).toBe(401);
  });
});
