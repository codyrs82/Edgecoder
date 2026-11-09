import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { decodeJwtPayload, hashPassword, normalizeEmail, parseCookies, readCookie, sha256Hex, verifyPassword } from "../../src/portal/portal-utils.js";
import { registerAuthRoutes } from "../../src/portal/routes/auth.js";

// Email verification must not ratify credentials set up by whoever registered the address:
// opening the link changes nothing, and confirming needs the account's own session or password.

type User = { userId: string; email: string; emailVerified: boolean; passwordHash?: string | null; role: "user" };

function build() {
  const users = new Map<string, User>();
  const sessions = new Map<string, string>(); // token -> userId
  const verifications = new Map<string, { userId: string; consumed: boolean; createdAtMs: number }>(); // tokenHash ->
  const apiKeys = new Map<string, string>(); // keyId -> userId
  const passkeys = new Map<string, string>(); // credentialId -> userId
  const links = new Map<string, string>(); // provider|subject -> userId
  const githubTokens = new Map<string, string>();
  const sent: string[] = [];
  let n = 0;
  const dropUser = <V>(m: Map<string, V>, userId: string, get: (v: V) => string) => {
    for (const [k, v] of m) if (get(v) === userId) m.delete(k);
  };
  const store = {
    getUserById: vi.fn(async (id: string) => (users.has(id) ? { ...users.get(id)! } : null)),
    getUserByEmail: vi.fn(async (email: string) => {
      const u = [...users.values()].find((x) => x.email === email);
      return u ? { ...u } : null;
    }),
    createUser: vi.fn(async (u: User) => {
      users.set(u.userId, { ...u, role: "user" });
      return { ...users.get(u.userId)! };
    }),
    createEmailVerification: vi.fn(async (v: { userId: string; tokenHash: string }) => {
      verifications.set(v.tokenHash, { userId: v.userId, consumed: false, createdAtMs: Date.now() });
    }),
    findEmailVerification: vi.fn(async (hash: string) => {
      const v = verifications.get(hash);
      return v && !v.consumed ? { userId: v.userId } : null;
    }),
    countRecentEmailVerifications: vi.fn(async (userId: string, sinceMs: number) =>
      [...verifications.values()].filter((v) => v.userId === userId && v.createdAtMs >= sinceMs).length
    ),
    consumeEmailVerification: vi.fn(async (hash: string) => {
      const v = verifications.get(hash);
      if (!v || v.consumed) return null;
      v.consumed = true;
      return { userId: v.userId };
    }),
    markUserEmailVerified: vi.fn(async (id: string) => {
      users.get(id)!.emailVerified = true;
    }),
    deleteSessionsForUser: vi.fn(async (id: string) => dropUser(sessions, id, (v) => v)),
    deleteSessionByTokenHash: vi.fn(async (hash: string) => {
      for (const k of sessions.keys()) if (sha256Hex(k) === hash) sessions.delete(k);
    }),
    revokeAllApiKeys: vi.fn(async (id: string) => {
      const before = apiKeys.size;
      dropUser(apiKeys, id, (v) => v);
      return before - apiKeys.size;
    }),
    deletePasskeysForUser: vi.fn(async (id: string) => dropUser(passkeys, id, (v) => v)),
    deleteOauthLinksForUser: vi.fn(async (id: string) => dropUser(links, id, (v) => v)),
    deleteGitHubToken: vi.fn(async (id: string) => void githubTokens.delete(id))
  };
  const app = Fastify();
  registerAuthRoutes(app, {
    store,
    oauthProviders: {},
    PORTAL_PUBLIC_URL: "https://portal.example",
    EMAIL_VERIFY_TTL_MS: 60_000,
    parseCookies,
    readCookie,
    normalizeEmail,
    decodeJwtPayload,
    sha256Hex,
    hashPassword,
    verifyPassword,
    clearCookies: () => [],
    ensureCreditAccountForUser: async () => {},
    sendVerificationEmail: async (email: string, token: string) => void sent.push(`${email} ${token}`),
    createSessionForUser: async (userId: string) => {
      const token = `sess-${++n}`;
      sessions.set(token, userId);
      return token;
    },
    getCurrentUser: async (req: { headers: Record<string, unknown> }) => {
      const cookieToken = readCookie(parseCookies(String(req.headers.cookie ?? "")), "edgecoder_portal_session");
      const auth = String(req.headers.authorization ?? "");
      const token = cookieToken ?? (auth.startsWith("Bearer ") ? auth.slice(7) : undefined);
      const userId = token ? sessions.get(token) : undefined;
      return userId && users.has(userId) ? { ...users.get(userId)! } : null;
    }
  } as any);

  /** An account someone registered, with every kind of credential attached, and a pending link. */
  const seed = (opts: { password?: string | null } = {}) => {
    const password = opts.password === undefined ? "attacker-pass" : opts.password;
    users.set("u1", { userId: "u1", email: "owner@example.test", emailVerified: false, passwordHash: password ? hashPassword(password) : null, role: "user" });
    sessions.set("registrant-session", "u1");
    apiKeys.set("k1", "u1");
    passkeys.set("cred-1", "u1");
    links.set("microsoft|tid:oid", "u1");
    githubTokens.set("u1", "gh-token");
    const token = "link-token-0123456789";
    verifications.set(sha256Hex(token), { userId: "u1", consumed: false, createdAtMs: Date.now() });
    return token;
  };
  return { app, users, sessions, apiKeys, passkeys, links, githubTokens, verifications, sent, seed };
}

describe("email verification link", () => {
  it("GET only shows the confirmation page: it neither uses the link nor verifies", async () => {
    const ctx = build();
    const token = ctx.seed();
    const res = await ctx.app.inject({ url: `/auth/verify-email?token=${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).not.toContain(token);
    expect(ctx.users.get("u1")!.emailVerified).toBe(false);
    expect(ctx.verifications.get(sha256Hex(token))!.consumed).toBe(false);
  });

  it("the inbox owner without the account's session or password cannot verify it", async () => {
    const ctx = build();
    const token = ctx.seed();
    const res = await ctx.app.inject({ method: "POST", url: "/auth/verify-email", payload: { token } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("verify_password_required");
    const wrong = await ctx.app.inject({ method: "POST", url: "/auth/verify-email", payload: { token, password: "guess-guess" } });
    expect(wrong.statusCode).toBe(401);
    expect(ctx.users.get("u1")!.emailVerified).toBe(false);
    // The link is not used up by a failed attempt, and nothing was granted.
    expect(ctx.verifications.get(sha256Hex(token))!.consumed).toBe(false);
    expect(ctx.sessions.get("registrant-session")).toBe("u1");
  });

  it("a session for another account does not count", async () => {
    const ctx = build();
    const token = ctx.seed();
    ctx.users.set("u2", { userId: "u2", email: "other@example.test", emailVerified: true, role: "user" });
    ctx.sessions.set("other-session", "u2");
    const res = await ctx.app.inject({ method: "POST", url: "/auth/verify-email", headers: { cookie: "__Host-edgecoder_portal_session=other-session" }, payload: { token } });
    expect(res.statusCode).toBe(401);
    expect(ctx.users.get("u1")!.emailVerified).toBe(false);
  });

  it("a passwordless account (e.g. created by a Microsoft sign-in) needs its own session", async () => {
    const ctx = build();
    const token = ctx.seed({ password: null });
    const res = await ctx.app.inject({ method: "POST", url: "/auth/verify-email", payload: { token, password: "anything-at-all" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("verify_sign_in_required");
    expect(ctx.users.get("u1")!.emailVerified).toBe(false);
  });

  it("normal flow: sign up, open the link, enter the password: verified and signed in, earlier credentials revoked", async () => {
    const ctx = build();
    const signup = await ctx.app.inject({ method: "POST", url: "/auth/signup", payload: { email: "new@example.test", password: "correct-horse" } });
    expect(signup.statusCode).toBe(200);
    const userId = signup.json().userId as string;
    const token = ctx.sent[0].split(" ")[1];
    ctx.sessions.set("pre-verify-session", userId);
    ctx.apiKeys.set("k-old", userId);
    ctx.passkeys.set("cred-old", userId);
    ctx.links.set("google|old", userId);
    const res = await ctx.app.inject({ method: "POST", url: "/auth/verify-email", payload: { token, password: "correct-horse" } });
    expect(res.statusCode).toBe(200);
    const { sessionToken } = res.json();
    expect(ctx.users.get(userId)!.emailVerified).toBe(true);
    expect(ctx.sessions.get(sessionToken)).toBe(userId);
    expect(ctx.sessions.has("pre-verify-session")).toBe(false);
    expect(ctx.apiKeys.size).toBe(0);
    expect(ctx.passkeys.size).toBe(0);
    expect(ctx.links.size).toBe(0);
    // Single use.
    const again = await ctx.app.inject({ method: "POST", url: "/auth/verify-email", payload: { token, password: "correct-horse" } });
    expect(again.statusCode).toBe(400);
  });

  it("confirming from the account's own session works; a passwordless account keeps its provider link", async () => {
    const ctx = build();
    const token = ctx.seed({ password: null });
    const res = await ctx.app.inject({ method: "POST", url: "/auth/verify-email", headers: { authorization: "Bearer registrant-session" }, payload: { token } });
    expect(res.statusCode).toBe(200);
    expect(ctx.users.get("u1")!.emailVerified).toBe(true);
    expect(ctx.sessions.has("registrant-session")).toBe(false);
    expect(ctx.apiKeys.size).toBe(0);
    expect(ctx.passkeys.size).toBe(0);
    expect(ctx.links.get("microsoft|tid:oid")).toBe("u1");
  });

  it("an unknown or used link is refused", async () => {
    const ctx = build();
    ctx.seed();
    const res = await ctx.app.inject({ method: "POST", url: "/auth/verify-email", payload: { token: "not-a-real-token-123", password: "attacker-pass" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("verify_link_invalid");
  });
});

describe("verification rate limit", () => {
  it("POST /auth/verify-email (password check) is in the per-IP auth bucket", async () => {
    const { rateLimitFor, AUTH_RATE_LIMIT } = await import("../../src/portal/security.js");
    expect(rateLimitFor("/auth/verify-email", "POST")).toEqual(AUTH_RATE_LIMIT);
  });
});
