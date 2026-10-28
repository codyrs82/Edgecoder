import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerPortalSecurity, rateLimitFor, trustProxyHops } from "../../src/portal/security.js";
import { clearCookies, cookieName, encodeCookie, readCookie } from "../../src/portal/portal-utils.js";

// #10: security headers, CSRF origin check, rate limits and cookie hardening.
async function buildApp() {
  const app = Fastify({ trustProxy: 1 });
  await registerPortalSecurity(app, {
    publicOrigin: "https://edgecoder.io",
    trustedOrigins: ["tauri://localhost"],
  });
  app.get("/", async (_req, reply) => reply.type("text/html").send("<html></html>"));
  app.post("/auth/login", async () => ({ ok: true }));
  app.post("/wallet/send/mfa/start", async () => ({ ok: true }));
  app.post("/me/theme", async () => ({ ok: true }));
  app.post("/auth/oauth/apple/callback", async () => ({ ok: true }));
  app.post("/auth/oauth/:provider/callback", async () => ({ ok: true }));
  app.get("/wallet/send/requests", async () => ({ requests: [] }));
  await app.ready();
  return app;
}

describe("portal security headers (#10)", () => {
  it("sets CSP (report-only), HSTS, frame and nosniff headers", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/" });
    const csp = res.headers["content-security-policy-report-only"] ?? res.headers["content-security-policy"];
    expect(String(csp)).toContain("frame-ancestors 'none'");
    expect(String(csp)).toContain("script-src 'self'");
    expect(res.headers["strict-transport-security"]).toContain("max-age=31536000");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("portal rate limits (#10)", () => {
  it("maps auth and wallet routes to limits", () => {
    expect(rateLimitFor("/auth/login")?.max).toBe(10);
    expect(rateLimitFor("/auth/passkey/login/verify")?.max).toBe(10);
    expect(rateLimitFor("/auth/oauth/:provider/callback")?.max).toBe(10);
    expect(rateLimitFor("/wallet/send/mfa/confirm")?.max).toBe(5);
    expect(rateLimitFor("/wallet/send/mfa/start")?.max).toBe(5);
    expect(rateLimitFor("/wallet/send/requests", "GET")).toBeUndefined();
    expect(rateLimitFor("/wallet/send/mfa/start", "GET")).toBeUndefined();
    expect(rateLimitFor("/me/theme")).toBeUndefined();
  });

  it("11th /auth/login in a minute from one IP gets 429; another IP is unaffected", async () => {
    const app = await buildApp();
    const hit = (ip: string) => app.inject({ method: "POST", url: "/auth/login", remoteAddress: ip, payload: {} });
    for (let i = 0; i < 10; i++) expect((await hit("10.0.0.1")).statusCode).toBe(200);
    expect((await hit("10.0.0.1")).statusCode).toBe(429);
    expect((await hit("10.0.0.2")).statusCode).toBe(200);
  });

  it("GET /wallet/send/requests is not rate-limited", async () => {
    const app = await buildApp();
    for (let i = 0; i < 12; i++) {
      expect((await app.inject({ method: "GET", url: "/wallet/send/requests", remoteAddress: "10.0.0.4" })).statusCode).toBe(200);
    }
  });

  it("6th wallet send/MFA request gets 429", async () => {
    const app = await buildApp();
    const hit = () => app.inject({ method: "POST", url: "/wallet/send/mfa/start", remoteAddress: "10.0.0.3", payload: {} });
    for (let i = 0; i < 5; i++) expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(429);
  });
});

describe("portal CSRF origin check (#10)", () => {
  it("rejects a cross-site POST", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/me/theme", headers: { origin: "https://evil.example" }, payload: {} });
    expect(res.statusCode).toBe(403);
    const sfs = await app.inject({ method: "POST", url: "/me/theme", headers: { "sec-fetch-site": "cross-site" }, payload: {} });
    expect(sfs.statusCode).toBe(403);
  });

  it("allows the portal origin, the desktop origin, same-host and server-to-server POSTs", async () => {
    const app = await buildApp();
    for (const headers of [
      { origin: "https://edgecoder.io" },
      { origin: "tauri://localhost" },
      { origin: "https://edgecoder-portal.fly.dev", host: "edgecoder-portal.fly.dev" },
      {},
    ]) {
      expect((await app.inject({ method: "POST", url: "/me/theme", headers, payload: {} })).statusCode).toBe(200);
    }
  });

  it("does NOT exempt the generic OAuth callback (login CSRF)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/auth/oauth/google/callback", headers: { origin: "https://evil.example" }, payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it("PORTAL_TRUST_PROXY_HOPS falls back to 1 on bad values", () => {
    expect(trustProxyHops(undefined)).toBe(1);
    expect(trustProxyHops("2")).toBe(2);
    for (const bad of ["true", "0", "-1", "1.5", "abc"]) expect(trustProxyHops(bad), bad).toBe(1);
  });

  it("exempts the Apple form_post OAuth callback", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/auth/oauth/apple/callback", headers: { origin: "https://appleid.apple.com" }, payload: {} });
    expect(res.statusCode).toBe(200);
  });
});

describe("session cookie hardening (#10)", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env.NODE_ENV = env.NODE_ENV;
    if (env.PORTAL_COOKIE_SECURE === undefined) delete process.env.PORTAL_COOKIE_SECURE;
    else process.env.PORTAL_COOKIE_SECURE = env.PORTAL_COOKIE_SECURE;
  });

  it("in production uses __Host- prefix, Secure, HttpOnly, SameSite=Lax", () => {
    process.env.NODE_ENV = "production";
    const c = encodeCookie("edgecoder_portal_session", "tok", 60);
    expect(c.startsWith("__Host-edgecoder_portal_session=tok;")).toBe(true);
    for (const attr of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"]) expect(c).toContain(attr);
    expect(c).not.toMatch(/Domain=/i);
  });

  it("PORTAL_COOKIE_SECURE=1 turns it on outside production", () => {
    process.env.NODE_ENV = "development";
    process.env.PORTAL_COOKIE_SECURE = "1";
    expect(cookieName("x")).toBe("__Host-x");
  });

  it("dev keeps the plain name; reader accepts both; logout clears both", () => {
    process.env.NODE_ENV = "development";
    delete process.env.PORTAL_COOKIE_SECURE;
    expect(encodeCookie("s", "v", 1).startsWith("s=v;")).toBe(true);
    expect(readCookie({ "__Host-s": "new" }, "s")).toBe("new");
    expect(readCookie({ s: "old" }, "s")).toBe("old");
    process.env.NODE_ENV = "production";
    const cleared = clearCookies("s");
    expect(cleared).toHaveLength(2);
    expect(cleared[0]).toMatch(/^__Host-s=;/);
    expect(cleared[1]).toMatch(/^s=;/);
  });
});
