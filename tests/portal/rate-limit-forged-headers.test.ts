import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { ORIGIN_LOCK_HEADER, registerPortalSecurity, type PortalSecurityOptions } from "../../src/portal/security.js";

// Forged client-IP headers must not buy a fresh rate-limit bucket: unless the request provably came
// through the locked Cloudflare edge (or Fly-Client-IP is explicitly trusted on Fly), the key is the
// socket address, so rotating the header still hits the limit.
async function buildApp(opts: Partial<PortalSecurityOptions> = {}) {
  const app = Fastify({ trustProxy: false });
  await registerPortalSecurity(app, { publicOrigin: "https://edgecoder.io", trustedOrigins: [], env: {}, ...opts });
  app.post("/auth/login", async () => ({ ok: true }));
  await app.ready();
  return app;
}

type App = Awaited<ReturnType<typeof buildApp>>;

/** 11 logins from one socket address, header value rotated each time; returns the status codes. */
async function rotate(app: App, header: (i: number) => Record<string, string>) {
  const codes: number[] = [];
  for (let i = 0; i < 11; i++) {
    const res = await app.inject({ method: "POST", url: "/auth/login", remoteAddress: "10.5.0.1", headers: header(i), payload: {} });
    codes.push(res.statusCode);
  }
  return codes;
}

const LIMITED = [...Array(10).fill(200), 429];

describe("forged client-IP headers are keyed by the socket address", () => {
  it("cf-connecting-ip with Cloudflare mode off", async () => {
    const app = await buildApp({ edge: "none" });
    expect(await rotate(app, (i) => ({ "cf-connecting-ip": `198.51.100.${i}` }))).toEqual(LIMITED);
  });

  it("cf-connecting-ip with Cloudflare mode on but no lock token configured", async () => {
    const app = await buildApp({ edge: "cloudflare" });
    expect(await rotate(app, (i) => ({ "cf-connecting-ip": `198.51.100.${i}`, [ORIGIN_LOCK_HEADER]: "guess" }))).toEqual(LIMITED);
  });

  it("cf-connecting-ip with a wrong lock token is refused by the origin lock", async () => {
    const app = await buildApp({ edge: "cloudflare", originLockToken: "real-lock" });
    const codes = await rotate(app, (i) => ({ "cf-connecting-ip": `198.51.100.${i}`, [ORIGIN_LOCK_HEADER]: "wrong" }));
    expect(codes.every((c) => c === 403)).toBe(true);
  });

  it("cf-connecting-ip without the lock header (service-token caller past the lock)", async () => {
    const app = await buildApp({ edge: "cloudflare", originLockToken: "real-lock", serviceToken: "svc" });
    expect(await rotate(app, (i) => ({ "cf-connecting-ip": `198.51.100.${i}`, "x-portal-service-token": "svc" }))).toEqual(LIMITED);
  });

  it("x-forwarded-for", async () => {
    const app = await buildApp({ edge: "cloudflare", originLockToken: "real-lock", serviceToken: "svc" });
    expect(await rotate(app, (i) => ({ "x-forwarded-for": `198.51.100.${i}`, "x-portal-service-token": "svc" }))).toEqual(LIMITED);
    const plain = await buildApp();
    expect(await rotate(plain, (i) => ({ "x-forwarded-for": `198.51.100.${i}, 10.0.0.1` }))).toEqual(LIMITED);
  });

  it("fly-client-ip when not trusted (flag unset, or flag set off Fly)", async () => {
    const unset = await buildApp({ env: { FLY_APP_NAME: "edgecoder-portal" } });
    expect(await rotate(unset, (i) => ({ "fly-client-ip": `198.51.100.${i}` }))).toEqual(LIMITED);
    const offFly = await buildApp({ env: { PORTAL_TRUST_FLY_CLIENT_IP: "true" } });
    expect(await rotate(offFly, (i) => ({ "fly-client-ip": `198.51.100.${i}` }))).toEqual(LIMITED);
  });

  it("control: a valid lock token keys on cf-connecting-ip", async () => {
    const app = await buildApp({ edge: "cloudflare", originLockToken: "real-lock" });
    expect(await rotate(app, (i) => ({ "cf-connecting-ip": `198.51.100.${i}`, [ORIGIN_LOCK_HEADER]: "real-lock" }))).toEqual(Array(11).fill(200));
  });

  it("control: trusted fly-client-ip on Fly keys on that header", async () => {
    const app = await buildApp({ env: { PORTAL_TRUST_FLY_CLIENT_IP: "true", FLY_APP_NAME: "edgecoder-portal" } });
    expect(await rotate(app, (i) => ({ "fly-client-ip": `198.51.100.${i}` }))).toEqual(Array(11).fill(200));
  });
});
