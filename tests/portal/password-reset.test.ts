import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, normalizeEmail, sha256Hex, verifyPassword } from "../../src/portal/portal-utils.js";
import {
  FORGOT_PASSWORD_RESPONSE,
  PASSWORD_RESET_MAX_PER_EMAIL,
  PASSWORD_RESET_TTL_MS,
  registerPasswordResetRoutes,
  type PasswordResetStore
} from "../../src/portal/routes/password-reset.js";
import { PASSWORD_RESET_RATE_LIMIT, rateLimitFor } from "../../src/portal/security.js";
import { registerResetPasswordPage } from "../../src/portal/pages/reset-password.js";
import { registerHomePage } from "../../src/portal/pages/home.js";

type User = { userId: string; email: string; passwordHash?: string; emailVerified: boolean };
type Reset = { tokenHash: string; userId: string; expiresAtMs: number; usedAtMs: number | null; createdAtMs: number };

/** In-memory store with the same semantics as the Postgres methods. */
function fakeStore() {
  const users = new Map<string, User>();
  const resets = new Map<string, Reset>();
  const sessions = new Map<string, string>(); // tokenHash -> userId
  const store: PasswordResetStore = {
    async getUserByEmail(email) {
      return [...users.values()].find((u) => u.email === email) ?? null;
    },
    async createPasswordReset({ tokenHash, userId, expiresAtMs }) {
      const now = Date.now();
      for (const r of resets.values()) if (r.userId === userId && r.usedAtMs === null) r.usedAtMs = now;
      resets.set(tokenHash, { tokenHash, userId, expiresAtMs, usedAtMs: null, createdAtMs: now });
    },
    async consumePasswordReset(tokenHash) {
      const r = resets.get(tokenHash);
      const now = Date.now();
      if (!r || r.usedAtMs !== null || r.expiresAtMs <= now) return null;
      r.usedAtMs = now;
      return { userId: r.userId };
    },
    async invalidatePasswordResets(userId) {
      for (const r of resets.values()) if (r.userId === userId && r.usedAtMs === null) r.usedAtMs = Date.now();
    },
    async countRecentPasswordResets(userId, sinceMs) {
      return [...resets.values()].filter((r) => r.userId === userId && r.createdAtMs >= sinceMs).length;
    },
    async setUserPassword(userId, passwordHash) {
      const u = [...users.values()].find((x) => x.userId === userId);
      if (u) u.passwordHash = passwordHash;
    },
    async deleteSessionsForUser(userId) {
      for (const [k, v] of sessions) if (v === userId) sessions.delete(k);
    },
    async markUserEmailVerified(userId) {
      const u = [...users.values()].find((x) => x.userId === userId);
      if (u) u.emailVerified = true;
    }
  };
  return { store, users, resets, sessions };
}

describe("password reset (/auth/password/*)", () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof fakeStore>;
  const sent: Array<{ email: string; token: string; ttlMinutes: number }> = [];
  const ssoNotices: string[] = [];

  beforeEach(async () => {
    sent.length = 0;
    ssoNotices.length = 0;
    db = fakeStore();
    db.users.set("u1", { userId: "u1", email: "user@example.test", passwordHash: hashPassword("old-password"), emailVerified: false });
    db.users.set("u2", { userId: "u2", email: "sso@example.test", emailVerified: true });
    db.sessions.set("s1", "u1");
    db.sessions.set("s2", "u1");
    db.sessions.set("s3", "u2");
    app = Fastify();
    registerPasswordResetRoutes(app, {
      store: db.store,
      hashPassword,
      normalizeEmail,
      sha256Hex,
      sendPasswordResetEmail: async (email, token, ttlMinutes) => {
        sent.push({ email, token, ttlMinutes });
      },
      sendPasswordResetSsoNoticeEmail: async (email) => {
        ssoNotices.push(email);
      }
    });
    registerResetPasswordPage(app);
    await app.ready();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  async function forgot(email: string) {
    return app.inject({ method: "POST", url: "/auth/password/forgot", payload: { email } });
  }
  async function requestToken(email = "user@example.test"): Promise<string> {
    const before = sent.length;
    await forgot(email);
    await vi.waitFor(() => expect(sent.length).toBe(before + 1));
    return sent[sent.length - 1].token;
  }
  async function reset(token: string, password = "brand-new-password") {
    return app.inject({ method: "POST", url: "/auth/password/reset", payload: { token, password } });
  }

  it("answers the same for an unknown email as for a real one (no enumeration)", async () => {
    const known = await forgot("User@Example.test");
    const unknown = await forgot("nobody@example.test");
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toBe(known.body);
    expect(known.json()).toEqual(FORGOT_PASSWORD_RESPONSE);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].email).toBe("user@example.test");
    expect(sent[0].ttlMinutes).toBe(30);
  });

  it("stores only the SHA-256 of a 32-byte token, expiring in 30 minutes", async () => {
    const token = await requestToken();
    expect(Buffer.from(token, "base64url").length).toBeGreaterThanOrEqual(32);
    expect(db.resets.has(token)).toBe(false);
    const row = db.resets.get(sha256Hex(token));
    expect(row).toBeDefined();
    expect(row!.expiresAtMs - row!.createdAtMs).toBe(PASSWORD_RESET_TTL_MS);
  });

  it("sets the password, revokes every session, verifies the email, and is single use", async () => {
    const token = await requestToken();
    const ok = await reset(token);
    expect(ok.statusCode).toBe(200);
    const user = db.users.get("u1")!;
    expect(verifyPassword("brand-new-password", user.passwordHash!)).toBe(true);
    expect(verifyPassword("old-password", user.passwordHash!)).toBe(false);
    expect([...db.sessions.values()]).toEqual(["u2"]);
    expect(user.emailVerified).toBe(true);

    const again = await reset(token, "another-password");
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe("reset_link_invalid");
    expect(verifyPassword("brand-new-password", db.users.get("u1")!.passwordHash!)).toBe(true);
  });

  it("rejects a wrong token with the generic error", async () => {
    await requestToken();
    const r = await reset("this-token-was-never-issued-by-the-portal");
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: "reset_link_invalid", message: "This reset link has expired or was already used." });
    expect(verifyPassword("old-password", db.users.get("u1")!.passwordHash!)).toBe(true);
  });

  it("rejects an expired token", async () => {
    const token = await requestToken();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + PASSWORD_RESET_TTL_MS + 1000);
    const r = await reset(token);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("reset_link_invalid");
  });

  it("invalidates an older link when a new one is requested", async () => {
    const first = await requestToken();
    const second = await requestToken();
    expect((await reset(first)).statusCode).toBe(400);
    expect((await reset(second)).statusCode).toBe(200);
  });

  it("applies the sign-up password rule without burning the token", async () => {
    const token = await requestToken();
    const weak = await reset(token, "short");
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error).toBe("weak_password");
    expect((await reset(token)).statusCode).toBe(200);
  });

  it("sends no link to an account without a password; it gets an SSO notice instead", async () => {
    const r = await forgot("sso@example.test");
    expect(r.json()).toEqual(FORGOT_PASSWORD_RESPONSE);
    await vi.waitFor(() => expect(ssoNotices).toEqual(["sso@example.test"]));
    expect(sent).toHaveLength(0);
    expect(db.users.get("u2")!.passwordHash).toBeUndefined();
  });

  it("caps reset emails per address, still answering the same", async () => {
    for (let i = 0; i < PASSWORD_RESET_MAX_PER_EMAIL; i += 1) await requestToken();
    const extra = await forgot("user@example.test");
    expect(extra.json()).toEqual(FORGOT_PASSWORD_RESPONSE);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(PASSWORD_RESET_MAX_PER_EMAIL);
  });

  it("is rate limited per IP through security.ts", () => {
    expect(rateLimitFor("/auth/password/forgot", "POST")).toEqual(PASSWORD_RESET_RATE_LIMIT);
    expect(rateLimitFor("/auth/password/reset", "POST")).toEqual(PASSWORD_RESET_RATE_LIMIT);
    expect(PASSWORD_RESET_RATE_LIMIT.max).toBeLessThanOrEqual(5);
  });

  it("renders the reset page without echoing the token", async () => {
    const r = await app.inject({ method: "GET", url: "/portal/reset-password?token=%3Cscript%3Ealert(1)%3C%2Fscript%3E" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toContain("<title>EdgeCoder Portal | Reset password</title>");
    expect(r.body).toContain('id="newPassword"');
    expect(r.body).toContain('id="confirmPassword"');
    expect(r.body).toContain('minlength="8"');
    expect(r.body).not.toContain("<script>alert(1)");
  });

  it("links to the reset page from the sign-in form", async () => {
    const home = Fastify();
    registerHomePage(home);
    const r = await home.inject({ method: "GET", url: "/portal" });
    expect(r.body).toMatch(/<a[^>]*href="\/portal\/reset-password"[^>]*>Forgot password\?<\/a>/);
    await home.close();
  });
});
