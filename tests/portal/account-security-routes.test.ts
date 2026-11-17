import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSecondFactorGate, isAdminActionRoute, registerAccountSecurityRoutes, registerAdminTwoFactorHook } from "../../src/portal/routes/account-security.js";
import { hashApiKey, registerHostedRoutes } from "../../src/portal/routes/hosted.js";
import { rateLimitFor, AUTH_RATE_LIMIT, WALLET_RATE_LIMIT } from "../../src/portal/security.js";
import { base32Decode, hotp, totpStep } from "../../src/portal/totp.js";
import { HOUR, testSecurity } from "./fixtures/account-security-memory.js";

type User = { userId: string; email: string; role?: "user" | "admin"; emailVerified?: boolean };
const USERS: Record<string, User> = {
  "s-user": { userId: "u1", email: "u1@mail.example", emailVerified: true },
  "s-user-2": { userId: "u1", email: "u1@mail.example", emailVerified: true },
  "s-admin": { userId: "a1", email: "admin@mail.example", role: "admin", emailVerified: true },
  "s-ops": { userId: "o1", email: "ops@mail.example", emailVerified: true }
};
const cookie = (s: string) => ({ cookie: `edgecoder_portal_session=${s}` });

async function setup() {
  const t = testSecurity();
  const passkeys = new Map<string, number>();
  const sessionsDeleted: string[] = [];
  const paused: string[] = [];
  const resumed: string[] = [];
  const audit: Array<{ action: string; targetUserId: string | null }> = [];
  const emails = { locked: [] as string[], twoFactor: [] as Array<{ email: string; enabled: boolean }> };
  const store = {
    listPasskeysByUserId: async (userId: string) => Array.from({ length: passkeys.get(userId) ?? 0 }, (_, i) => ({ credentialId: `c${i}` })),
    deleteSessionsForUser: async (userId: string) => void sessionsDeleted.push(userId),
    getUserById: async (userId: string) => Object.values(USERS).find((u) => u.userId === userId) ?? null,
    appendAdminAudit: async (e: { action: string; targetUserId: string | null }) => (audit.push(e), "audit-1")
  };
  const getCurrentUser = async (req: { headers: Record<string, unknown> }) => {
    const m = /edgecoder_portal_session=([\w-]+)/.exec(String(req.headers.cookie ?? ""));
    return m ? USERS[m[1]] ?? null : null;
  };
  const buildAccessContext = async (u: User) => ({ isSystemAdmin: u.role === "admin", canManageCoordinatorOps: u.role === "admin" || u.userId === "o1" });
  const app = Fastify();
  registerAdminTwoFactorHook(app, { security: t.security, store, getCurrentUser, buildAccessContext });
  registerAccountSecurityRoutes(app, {
    security: t.security,
    store,
    getCurrentUser,
    buildAccessContext,
    sendDestinationAdded: async () => undefined,
    sendAccountLocked: async (i) => void emails.locked.push(i.email),
    sendTwoFactorChanged: async (i) => void emails.twoFactor.push(i),
    pausePayouts: async (userId) => void paused.push(userId),
    resumePayouts: async (userId) => void resumed.push(userId)
  });
  // Stand-ins for admin actions (the hook guards every mutation under these prefixes).
  const adminAction = vi.fn(async () => ({ ok: true }));
  app.post("/portal/api/admin/invites", adminAction);
  app.post("/coordinator/ops/node-remove", adminAction);
  app.get("/portal/api/admin/users", adminAction);
  await app.ready();
  return { app, t, passkeys, sessionsDeleted, paused, resumed, audit, emails, adminAction };
}

async function enableTotp(s: Awaited<ReturnType<typeof setup>>, session: string) {
  const r = await s.app.inject({ method: "POST", url: "/portal/api/security/2fa/totp/setup", headers: cookie(session), payload: {} });
  expect(r.statusCode).toBe(200);
  const secret = base32Decode(r.json().secret);
  const enable = await s.app.inject({ method: "POST", url: "/portal/api/security/2fa/totp/enable", headers: cookie(session), payload: { code: hotp(secret, totpStep(s.t.clock.now)) } });
  expect(enable.statusCode).toBe(200);
  s.t.clock.now += 60_000;
  const code = () => hotp(secret, totpStep(s.t.clock.now));
  return { secret, code, recoveryCodes: enable.json().recoveryCodes as string[], setup: r.json() };
}

describe("2FA settings routes", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it("need a session", async () => {
    for (const [method, url] of [
      ["GET", "/portal/api/security/2fa"],
      ["POST", "/portal/api/security/2fa/totp/setup"],
      ["POST", "/portal/api/security/2fa/totp/enable"],
      ["POST", "/portal/api/security/2fa/totp/disable"],
      ["POST", "/portal/api/security/2fa/recovery-codes"],
      ["POST", "/portal/api/security/2fa/verify"],
      ["POST", "/portal/api/security/2fa/passkey/options"],
      ["POST", "/portal/api/security/2fa/passkey/verify"]
    ] as const) {
      expect((await s.app.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode, url).toBe(401);
    }
  });

  it("enrol: setup returns a QR and the secret; enable returns recovery codes and emails the owner", async () => {
    const before = await s.app.inject({ url: "/portal/api/security/2fa", headers: cookie("s-user") });
    expect(before.json()).toMatchObject({ enabled: false, totpEnabled: false, methods: [], admin: null, locked: null });
    const e = await enableTotp(s, "s-user");
    expect(e.setup.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(e.setup.qrSvg).toMatch(/^<svg/);
    expect(e.recoveryCodes).toHaveLength(10);
    expect(s.emails.twoFactor).toEqual([{ email: "u1@mail.example", enabled: true }]);
    const after = await s.app.inject({ url: "/portal/api/security/2fa", headers: cookie("s-user") });
    expect(after.json()).toMatchObject({ enabled: true, totpEnabled: true, recoveryCodesRemaining: 10 });
  });

  it("setup with 2FA already on (a passkey) needs the second factor first", async () => {
    s.passkeys.set("u1", 1);
    const r = await s.app.inject({ method: "POST", url: "/portal/api/security/2fa/totp/setup", headers: cookie("s-user"), payload: {} });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: "two_factor_required", methods: ["passkey"] });
  });

  it("verify makes a step-up for this session only; disable needs a code and emails the owner", async () => {
    const e = await enableTotp(s, "s-user");
    const v = await s.app.inject({ method: "POST", url: "/portal/api/security/2fa/verify", headers: cookie("s-user"), payload: { code: e.code() } });
    expect(v.statusCode).toBe(200);
    expect(v.json().stepUpActiveUntilMs).toBe(s.t.clock.now + 10 * 60 * 1000);
    expect((await s.app.inject({ url: "/portal/api/security/2fa", headers: cookie("s-user") })).json().stepUpActiveUntilMs).not.toBeNull();
    expect((await s.app.inject({ url: "/portal/api/security/2fa", headers: cookie("s-user-2") })).json().stepUpActiveUntilMs).toBeNull();
    // Replay of the same code is refused.
    expect((await s.app.inject({ method: "POST", url: "/portal/api/security/2fa/verify", headers: cookie("s-user"), payload: { code: e.code() } })).statusCode).toBe(401);

    expect((await s.app.inject({ method: "POST", url: "/portal/api/security/2fa/totp/disable", headers: cookie("s-user"), payload: { code: "000000" } })).statusCode).toBe(401);
    const off = await s.app.inject({ method: "POST", url: "/portal/api/security/2fa/totp/disable", headers: cookie("s-user"), payload: { code: e.recoveryCodes[0] } });
    expect(off.statusCode).toBe(200);
    expect(s.emails.twoFactor.at(-1)).toEqual({ email: "u1@mail.example", enabled: false });
  });

  it("recovery codes are single use through the API", async () => {
    const e = await enableTotp(s, "s-user");
    const use = () => s.app.inject({ method: "POST", url: "/portal/api/security/2fa/verify", headers: cookie("s-user"), payload: { code: e.recoveryCodes[3] } });
    expect((await use()).json()).toMatchObject({ ok: true, via: "recovery_code" });
    expect((await use()).statusCode).toBe(401);
  });

  it("second-factor routes share the wallet rate limit", () => {
    for (const url of ["/portal/api/security/2fa/verify", "/portal/api/security/2fa/totp/enable", "/portal/api/security/2fa/totp/disable", "/portal/api/security/2fa/recovery-codes", "/portal/api/security/2fa/passkey/verify"]) {
      expect(rateLimitFor(url, "POST"), url).toEqual(WALLET_RATE_LIMIT);
    }
    for (const url of ["/auth/account-security/confirm-destination", "/auth/account-security/cancel-destination", "/auth/account-security/lock"]) {
      expect(rateLimitFor(url, "POST"), url).toEqual(AUTH_RATE_LIMIT);
      expect(rateLimitFor(url, "GET"), url).toEqual(AUTH_RATE_LIMIT);
    }
  });
});

describe("emailed links", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it("GET only shows a page (no token in the HTML, nothing changes)", async () => {
    const token = await s.t.security.issueLockToken("u1");
    for (const path of ["confirm-destination", "cancel-destination", "lock"]) {
      const r = await s.app.inject({ url: `/auth/account-security/${path}?token=${encodeURIComponent(token)}` });
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toMatch(/text\/html/);
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.body).not.toContain(token);
    }
    expect((await s.t.security.load("u1")).lock).toBeUndefined();
  });

  it("the lock link pauses payouts, signs out every session and emails the owner; an admin unlocks", async () => {
    const token = await s.t.security.issueLockToken("u1");
    expect((await s.app.inject({ method: "POST", url: "/auth/account-security/lock", payload: { token: "x".repeat(30) } })).statusCode).toBe(400);
    const r = await s.app.inject({ method: "POST", url: "/auth/account-security/lock", payload: { token } });
    expect(r.statusCode).toBe(200);
    expect(s.sessionsDeleted).toEqual(["u1"]);
    expect(s.paused).toEqual(["u1"]);
    expect(s.emails.locked).toEqual(["u1@mail.example"]);

    // Only system admins see and unlock locked accounts.
    expect((await s.app.inject({ url: "/portal/api/admin/security/locked", headers: cookie("s-user") })).statusCode).toBe(403);
    expect((await s.app.inject({ method: "POST", url: "/portal/api/admin/security/u1/unlock", headers: cookie("s-user"), payload: {} })).statusCode).toBe(403);
    const list = await s.app.inject({ url: "/portal/api/admin/security/locked", headers: cookie("s-admin") });
    expect(list.json().accounts).toEqual([{ userId: "u1", email: "u1@mail.example", lockedAtMs: s.t.clock.now, source: "receipt_link" }]);
    const unlock = await s.app.inject({ method: "POST", url: "/portal/api/admin/security/u1/unlock", headers: cookie("s-admin"), payload: {} });
    expect(unlock.statusCode).toBe(200);
    expect(s.resumed).toEqual(["u1"]);
    expect(s.audit).toEqual([expect.objectContaining({ action: "account.unlock", targetUserId: "u1" })]);
    expect((await s.app.inject({ method: "POST", url: "/portal/api/admin/security/u1/unlock", headers: cookie("s-admin"), payload: {} })).statusCode).toBe(409);
  });
});

describe("admin actions and 2FA", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it("covers mutations under the admin prefixes only", () => {
    expect(isAdminActionRoute("POST", "/portal/api/admin/invites")).toBe(true);
    expect(isAdminActionRoute("DELETE", "/coordinator/ops/x")).toBe(true);
    expect(isAdminActionRoute("POST", "/admin/network/registry/suspend")).toBe(true);
    expect(isAdminActionRoute("GET", "/portal/api/admin/users")).toBe(false);
    expect(isAdminActionRoute("POST", "/portal/api/keys")).toBe(false);
  });

  it("a system admin without 2FA works during the grace period, then must enable it", async () => {
    const act = () => s.app.inject({ method: "POST", url: "/portal/api/admin/invites", headers: cookie("s-admin"), payload: {} });
    expect((await act()).statusCode).toBe(200);
    const status = await s.app.inject({ url: "/portal/api/security/2fa", headers: cookie("s-admin") });
    expect(status.json().admin).toMatchObject({ required: true, enabled: false, enforced: false });
    s.t.clock.now += 8 * 24 * HOUR;
    const refused = await act();
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("two_factor_enrollment_required");
    // Reads stay open (the banner tells them what to do).
    expect((await s.app.inject({ url: "/portal/api/admin/users", headers: cookie("s-admin") })).statusCode).toBe(200);
    const e = await enableTotp(s, "s-admin");
    expect((await act()).statusCode).toBe(403);
    expect((await s.app.inject({ method: "POST", url: "/portal/api/admin/invites", headers: { ...cookie("s-admin"), "x-edgecoder-2fa-code": e.code() }, payload: {} })).statusCode).toBe(200);
    expect((await act()).statusCode).toBe(200); // the step-up covers the session
  });

  it("an admin with 2FA must give it for admin actions; non-admins pass to the route's own check", async () => {
    await enableTotp(s, "s-ops");
    const r = await s.app.inject({ method: "POST", url: "/coordinator/ops/node-remove", headers: cookie("s-ops"), payload: {} });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("two_factor_required");
    // An ordinary user (even with 2FA) is not stopped by the hook: the route refuses them itself.
    await enableTotp(s, "s-user");
    s.adminAction.mockClear();
    expect((await s.app.inject({ method: "POST", url: "/portal/api/admin/invites", headers: cookie("s-user"), payload: {} })).statusCode).toBe(200);
    expect(s.adminAction).toHaveBeenCalledTimes(1);
    // No session: the hook does nothing.
    expect((await s.app.inject({ method: "POST", url: "/portal/api/admin/invites", payload: {} })).statusCode).toBe(200);
  });
});

describe("API key creation and 2FA", () => {
  it("needs the second factor when the account has 2FA", async () => {
    const t = testSecurity();
    const keys = new Map<string, string>();
    const store = {
      userForApiKeyHash: async (h: string) => keys.get(h) ?? null,
      createApiKey: async (k: { keyHash: string; userId: string }) => void keys.set(k.keyHash, k.userId),
      countApiKeys: async () => keys.size,
      listApiKeys: async () => [],
      revokeApiKey: async () => true,
      setDisplayName: async () => undefined
    };
    const app = Fastify();
    registerHostedRoutes(app, {
      store: store as never,
      getCurrentUser: async (req) => (String(req.headers.cookie ?? "").includes("sess") ? { userId: "u1", emailVerified: true } : null),
      PORTAL_SERVICE_TOKEN: "svc",
      EXTERNAL_HTTP_TIMEOUT_MS: 1000,
      discoverCoordinatorUrlsForPortal: async () => [],
      secondFactor: createSecondFactorGate(t.security, { listPasskeysByUserId: async () => [] })
    });
    await app.ready();
    const create = (headers: Record<string, string> = {}) => app.inject({ method: "POST", url: "/portal/api/keys", headers: { cookie: "edgecoder_portal_session=sess", ...headers }, payload: { name: "Cursor" } });
    expect((await create()).statusCode).toBe(200);
    const setup = await t.security.startTotp("u1", "u1@mail.example");
    if (!setup.ok) throw new Error("setup");
    const secret = base32Decode(setup.secret);
    await t.security.enableTotp("u1", hotp(secret, totpStep(t.clock.now)));
    t.clock.now += 60_000;
    const refused = await create();
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("two_factor_required");
    const ok = await create({ "x-edgecoder-2fa-code": hotp(secret, totpStep(t.clock.now)) });
    expect(ok.statusCode).toBe(200);
    expect([...keys.keys()]).toContain(hashApiKey(ok.json().key));
  });
});
