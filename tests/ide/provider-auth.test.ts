import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveListenOptions, isWebOrigin, isLoopbackHost } from "../../src/apps/ide/ide-auth.js";

const TOKEN = "test-ide-token-0123456789abcdef";
process.env.IDE_PROVIDER_TOKEN = TOKEN;
delete process.env.IDE_PROVIDER_HOST;

const { ideProviderServer: app } = await import("../../src/apps/ide/provider-server.js");
const HOST = "127.0.0.1:4304";

const ROUTES: Array<{ method: "GET" | "POST"; url: string; payload?: unknown }> = [
  { method: "GET", url: "/v1/models" },
  { method: "POST", url: "/v1/chat/completions", payload: {} },
  { method: "POST", url: "/v1/ide/chat", payload: {} },
  { method: "POST", url: "/v1/ide/tool-approval", payload: { id: "nope", approved: false } },
  { method: "POST", url: "/run", payload: {} },
  { method: "GET", url: "/models" },
  { method: "GET", url: "/v1/ide/project" },
  { method: "GET", url: "/v1/router/status" }
];

describe("IDE provider server auth (#4)", () => {
  beforeAll(async () => {
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  for (const r of ROUTES) {
    it(`${r.method} ${r.url}: 401 without token`, async () => {
      const res = await app.inject({ method: r.method, url: r.url, payload: r.payload as any, headers: { host: HOST } });
      expect(res.statusCode).toBe(401);
    });
    it(`${r.method} ${r.url}: 401 with wrong token`, async () => {
      const res = await app.inject({
        method: r.method,
        url: r.url,
        payload: r.payload as any,
        headers: { host: HOST, authorization: "Bearer wrong-token" }
      });
      expect(res.statusCode).toBe(401);
    });
  }

  it("right token passes the auth hook", async () => {
    for (const url of ["/v1/ide/project", "/models"]) {
      const res = await app.inject({ method: "GET", url, headers: { host: HOST, authorization: `Bearer ${TOKEN}` } });
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    }
    const res = await app.inject({
      method: "POST",
      url: "/v1/ide/tool-approval",
      payload: { id: "nope", approved: false },
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` }
    });
    expect(res.statusCode).toBe(404); // reached the handler
  });

  it("/health is public", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
  });

  it("web Origin is rejected with 403 even with a valid token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { host: HOST, origin: "https://evil.example", authorization: `Bearer ${TOKEN}` }
    });
    expect(res.statusCode).toBe(403);
  });

  it("foreign Host (DNS rebinding) is rejected with 403", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "evil.example:4304" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("resolveListenOptions", () => {
  it("defaults to 127.0.0.1:4304", () => {
    expect(resolveListenOptions({})).toEqual({ host: "127.0.0.1", port: 4304 });
  });
  it("refuses a non-loopback host without IDE_PROVIDER_TOKEN", () => {
    expect(() => resolveListenOptions({ IDE_PROVIDER_HOST: "0.0.0.0" })).toThrow(/IDE_PROVIDER_TOKEN/);
  });
  it("allows a non-loopback host with an explicit token", () => {
    expect(resolveListenOptions({ IDE_PROVIDER_HOST: "0.0.0.0", IDE_PROVIDER_TOKEN: "x" }).host).toBe("0.0.0.0");
  });
  it("loopback detection", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
  it("origin classification", () => {
    expect(isWebOrigin(undefined)).toBe(false);
    expect(isWebOrigin("https://evil.example")).toBe(true);
    expect(isWebOrigin("null")).toBe(true);
    expect(isWebOrigin("tauri://localhost")).toBe(false);
  });
});
