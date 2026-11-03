import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeJwtPayload, normalizeEmail, parseCookies, readCookie } from "../../src/portal/portal-utils.js";
import { OAUTH_STATE_COOKIE } from "../../src/portal/oauth-state-cookie.js";
import { decideUnlinkedOauthLogin, oauthProfileFrom } from "../../src/portal/oauth-identity.js";

/** What the fake identity provider answers for the current test. */
const idp: { idClaims: Record<string, unknown> | null; userInfo: Record<string, unknown> | null; githubEmails: unknown } = {
  idClaims: null,
  userInfo: null,
  githubEmails: null
};
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const ok = (body: unknown) => ({ statusCode: 200, body: { json: async () => body, text: async () => JSON.stringify(body), dump: async () => {} } });

vi.mock("undici", () => ({
  request: vi.fn(async (url: string) => {
    if (url.endsWith("/token")) return ok({ access_token: "at", ...(idp.idClaims ? { id_token: jwt(idp.idClaims) } : {}) });
    if (url.endsWith("/userinfo")) return ok(idp.userInfo ?? {});
    if (url === "https://api.github.com/user/emails") return ok(idp.githubEmails ?? []);
    return { statusCode: 404, body: { json: async () => ({}), text: async () => "", dump: async () => {} } };
  })
}));
const { registerAuthRoutes } = await import("../../src/portal/routes/auth.js");

type User = { userId: string; email: string; emailVerified: boolean; passwordHash?: string; role: "user" | "admin" };

function build() {
  const users = new Map<string, User>();
  const links = new Map<string, { userId: string; tenantId?: string }>();
  const states = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, string>(); // token -> userId
  const githubTokens = new Map<string, string>();
  let n = 0;
  const store = {
    createOauthState: vi.fn(async (s: { stateId: string }) => void states.set(s.stateId, s)),
    consumeOauthState: vi.fn(async (id: string) => {
      const s = states.get(id);
      states.delete(id);
      return s ?? null;
    }),
    findOauthIdentity: vi.fn(async (provider: string, subject: string) => {
      const l = links.get(`${provider}|${subject}`);
      return l ? { userId: l.userId } : null;
    }),
    linkOauthIdentity: vi.fn(async (i: { provider: string; providerSubject: string; userId: string; tenantId?: string }) => {
      links.set(`${i.provider}|${i.providerSubject}`, { userId: i.userId, tenantId: i.tenantId });
    }),
    getUserById: vi.fn(async (id: string) => (users.has(id) ? { ...users.get(id)! } : null)),
    getUserByEmail: vi.fn(async (email: string) => {
      const u = [...users.values()].find((x) => x.email === email);
      return u ? { ...u } : null;
    }),
    createUser: vi.fn(async (u: { userId: string; email: string; emailVerified: boolean }) => {
      const user: User = { ...u, role: "user" };
      users.set(u.userId, user);
      return { ...user };
    }),
    markUserEmailVerified: vi.fn(async (id: string) => {
      const u = users.get(id);
      if (u) u.emailVerified = true;
    }),
    saveGitHubToken: vi.fn(async (t: { userId: string; accessToken: string }) => void githubTokens.set(t.userId, t.accessToken))
  };
  const cfg = (name: string) => ({
    clientId: "cid",
    clientSecret: "secret",
    scopes: "openid",
    authorizeUrl: `https://${name}.idp.example/auth`,
    tokenUrl: `https://${name}.idp.example/token`,
    userinfoUrl: `https://${name}.idp.example/userinfo`
  });
  const app = Fastify();
  registerAuthRoutes(app, {
    store,
    oauthProviders: { google: cfg("google"), microsoft: cfg("microsoft"), github: cfg("github") },
    PORTAL_PUBLIC_URL: "https://portal.example",
    OAUTH_MICROSOFT_PROMPT: "",
    normalizeNativeOauthRedirect: () => null,
    parseCookies,
    readCookie,
    normalizeEmail,
    decodeJwtPayload,
    ensureCreditAccountForUser: async () => {},
    createSessionForUser: async (userId: string) => {
      const token = `sess-${++n}`;
      sessions.set(token, userId);
      return token;
    },
    getCurrentUser: async (req: { headers: Record<string, unknown> }) => {
      const token = readCookie(parseCookies(String(req.headers.cookie ?? "")), "edgecoder_portal_session");
      const userId = token ? sessions.get(token) : undefined;
      return userId && users.has(userId) ? { ...users.get(userId)! } : null;
    },
    issueMobileOauthSessionToken: async () => "mobile"
  } as any);
  const addUser = (u: Partial<User> & { userId: string; email: string }) => users.set(u.userId, { emailVerified: false, role: "user", ...u });
  return { app, store, users, links, sessions, githubTokens, addUser };
}

type Ctx = ReturnType<typeof build>;

function stateCookie(res: { headers: Record<string, unknown> }) {
  return ([] as string[]).concat(res.headers["set-cookie"] as string | string[]).find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`))!.split(";")[0];
}

/** Runs /start + /callback and returns the callback response and the session it created, if any. */
async function signIn(ctx: Ctx, provider: string) {
  const start = await ctx.app.inject({ url: `/auth/oauth/${provider}/start` });
  const state = new URL(String(start.headers.location)).searchParams.get("state")!;
  const before = new Set(ctx.sessions.keys());
  const res = await ctx.app.inject({ url: `/auth/oauth/${provider}/callback?code=c&state=${state}`, headers: { cookie: stateCookie(start) } });
  const newSession = [...ctx.sessions.keys()].find((k) => !before.has(k));
  return { res, sessionUser: newSession ? ctx.sessions.get(newSession) : undefined };
}

async function connect(ctx: Ctx, provider: string, sessionToken: string) {
  const session = `edgecoder_portal_session=${sessionToken}`;
  const start = await ctx.app.inject({ method: "POST", url: `/auth/oauth/${provider}/connect`, headers: { cookie: session }, payload: {} });
  expect(start.statusCode).toBe(200);
  const state = new URL(start.json().authorizeUrl).searchParams.get("state")!;
  return ctx.app.inject({ url: `/auth/oauth/${provider}/callback?code=c&state=${state}`, headers: { cookie: `${stateCookie(start)}; ${session}` } });
}

const google = (email: string, verified: boolean, sub = "g-1") => {
  idp.idClaims = { sub, email, email_verified: verified };
  idp.userInfo = { sub, email, email_verified: verified };
  idp.githubEmails = null;
};
const github = (emails: Array<{ email: string; primary: boolean; verified: boolean }>, profileEmail: string | null = null, id = 42) => {
  idp.idClaims = null;
  idp.userInfo = { id, login: "octo", email: profileEmail, avatar_url: "https://a.example/x.png" };
  idp.githubEmails = emails;
};
const microsoft = (email: string, oid = "oid-1", tid = "tid-1", sub = "ms-sub-1") => {
  idp.idClaims = { sub, oid, tid, email };
  idp.userInfo = { sub, email };
  idp.githubEmails = null;
};

describe("OAuth sign-in links only by a provider-verified email", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = build();
    ctx.addUser({ userId: "alice", email: "alice@example.test", emailVerified: true, passwordHash: "x" });
  });

  describe("google", () => {
    it("verified email links to the existing verified account", async () => {
      google("alice@example.test", true);
      const { res, sessionUser } = await signIn(ctx, "google");
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/portal/dashboard");
      expect(sessionUser).toBe("alice");
      expect(ctx.links.get("google|g-1")?.userId).toBe("alice");
    });

    it("unverified email does not link (error page, no session)", async () => {
      google("alice@example.test", false);
      const { res, sessionUser } = await signIn(ctx, "google");
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain("An account with this email already exists");
      expect(res.body).toContain("connect Google from Settings");
      expect(sessionUser).toBeUndefined();
      expect(ctx.links.size).toBe(0);
    });

    it("creates a new user (verified) when no account has the email", async () => {
      google("new@example.test", true, "g-new");
      const { res, sessionUser } = await signIn(ctx, "google");
      expect(res.statusCode).toBe(302);
      const created = [...ctx.users.values()].find((u) => u.email === "new@example.test")!;
      expect(created.emailVerified).toBe(true);
      expect(sessionUser).toBe(created.userId);
    });

    it("creates a new user (unverified) from an unverified claim, without marking it verified", async () => {
      google("other@example.test", false, "g-2");
      const { res } = await signIn(ctx, "google");
      expect(res.statusCode).toBe(302);
      expect([...ctx.users.values()].find((u) => u.email === "other@example.test")!.emailVerified).toBe(false);
    });

    it("an already linked identity still signs in", async () => {
      ctx.links.set("google|g-9", { userId: "alice" });
      google("whatever@example.test", false, "g-9");
      const { sessionUser } = await signIn(ctx, "google");
      expect(sessionUser).toBe("alice");
    });
  });

  describe("github", () => {
    it("primary verified email links to the existing account", async () => {
      github([{ email: "alice@example.test", primary: true, verified: true }]);
      const { res, sessionUser } = await signIn(ctx, "github");
      expect(res.statusCode).toBe(302);
      expect(sessionUser).toBe("alice");
      expect(ctx.githubTokens.get("alice")).toBe("at");
    });

    it("a verified but non-primary email does not link", async () => {
      github([
        { email: "someone@example.test", primary: true, verified: true },
        { email: "alice@example.test", primary: false, verified: true }
      ], "alice@example.test");
      const { res, sessionUser } = await signIn(ctx, "github");
      // The primary address is used, so a new account is made for it; alice is untouched.
      expect(res.statusCode).toBe(302);
      expect(sessionUser).not.toBe("alice");
      expect(ctx.githubTokens.has("alice")).toBe(false);
    });

    it("an unverified primary (or the public profile email) does not link", async () => {
      github([{ email: "alice@example.test", primary: true, verified: false }], "alice@example.test");
      const { res, sessionUser } = await signIn(ctx, "github");
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain("connect GitHub from Settings");
      expect(sessionUser).toBeUndefined();
      expect(ctx.githubTokens.has("alice")).toBe(false);
    });

    it("the profile email alone is never treated as verified", async () => {
      github([], "fresh@example.test", 77);
      await signIn(ctx, "github");
      expect([...ctx.users.values()].find((u) => u.email === "fresh@example.test")!.emailVerified).toBe(false);
    });

    it("creates a new verified user from the primary verified email", async () => {
      github([{ email: "dev@example.test", primary: true, verified: true }], null, 99);
      const { sessionUser } = await signIn(ctx, "github");
      const created = [...ctx.users.values()].find((u) => u.email === "dev@example.test")!;
      expect(created.emailVerified).toBe(true);
      expect(sessionUser).toBe(created.userId);
    });
  });

  describe("microsoft", () => {
    it("never links by email, even to a verified account", async () => {
      microsoft("alice@example.test");
      const { res, sessionUser } = await signIn(ctx, "microsoft");
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain("connect Microsoft from Settings");
      expect(sessionUser).toBeUndefined();
      expect(ctx.links.size).toBe(0);
    });

    it("keys the identity on tid + oid and records the tenant; the new account stays unverified", async () => {
      microsoft("ms-user@example.test", "oid-7", "tid-7");
      const { res, sessionUser } = await signIn(ctx, "microsoft");
      expect(res.statusCode).toBe(302);
      expect(ctx.links.get("microsoft|tid-7:oid-7")).toEqual({ userId: sessionUser, tenantId: "tid-7" });
      expect(ctx.users.get(sessionUser!)!.emailVerified).toBe(false);
    });

    it("the same oid in another tenant is a different identity", async () => {
      ctx.links.set("microsoft|tid-A:oid-1", { userId: "alice" });
      microsoft("alice@example.test", "oid-1", "tid-B", "other-sub");
      const { res, sessionUser } = await signIn(ctx, "microsoft");
      expect(res.statusCode).toBe(409);
      expect(sessionUser).toBeUndefined();
    });

    it("refuses a token without tid/oid", async () => {
      idp.idClaims = { sub: "s", email: "x@example.test" };
      idp.userInfo = { sub: "s" };
      const { res } = await signIn(ctx, "microsoft");
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("oauth_subject_missing");
    });

    it("carries a link keyed on the old per-app sub over to tid + oid", async () => {
      ctx.links.set("microsoft|legacy-sub", { userId: "alice" });
      microsoft("alice@example.test", "oid-3", "tid-3", "legacy-sub");
      const { sessionUser } = await signIn(ctx, "microsoft");
      expect(sessionUser).toBe("alice");
      expect(ctx.links.get("microsoft|tid-3:oid-3")).toEqual({ userId: "alice", tenantId: "tid-3" });
    });
  });

  describe("pre-registered account whose email was never verified", () => {
    beforeEach(() => {
      ctx.addUser({ userId: "squatter", email: "victim@example.test", emailVerified: false, passwordHash: "set-by-someone" });
      ctx.sessions.set("squatter-session", "squatter");
    });

    for (const [provider, setup] of [
      ["google", () => google("victim@example.test", true)],
      ["github", () => github([{ email: "victim@example.test", primary: true, verified: true }])]
    ] as const) {
      it(`${provider}: a verified login is not signed in to it, and does not verify it`, async () => {
        setup();
        const { res, sessionUser } = await signIn(ctx, provider);
        expect(res.statusCode).toBe(409);
        expect(res.body).toContain("has not been verified");
        expect(res.body).toContain("Forgot password");
        expect(sessionUser).toBeUndefined();
        expect(ctx.users.get("squatter")!.emailVerified).toBe(false);
        expect(ctx.links.size).toBe(0);
        expect(ctx.githubTokens.has("squatter")).toBe(false);
      });
    }

    it("microsoft: refused as well", async () => {
      microsoft("victim@example.test");
      const { res, sessionUser } = await signIn(ctx, "microsoft");
      expect(res.statusCode).toBe(409);
      expect(sessionUser).toBeUndefined();
    });
  });

  describe("connect a provider while signed in (Settings)", () => {
    beforeEach(() => {
      ctx.sessions.set("alice-session", "alice");
    });

    it("links Microsoft to the signed-in account; it then signs in", async () => {
      microsoft("anything@example.test", "oid-c", "tid-c");
      const res = await connect(ctx, "microsoft", "alice-session");
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/portal/settings?connected=microsoft");
      expect(ctx.links.get("microsoft|tid-c:oid-c")?.userId).toBe("alice");
      const { sessionUser } = await signIn(ctx, "microsoft");
      expect(sessionUser).toBe("alice");
    });

    it("needs a signed-in session to start", async () => {
      const res = await ctx.app.inject({ method: "POST", url: "/auth/oauth/google/connect", payload: {} });
      expect(res.statusCode).toBe(401);
    });

    it("refuses an identity already linked to another account", async () => {
      ctx.addUser({ userId: "bob", email: "bob@example.test", emailVerified: true });
      ctx.links.set("google|g-bob", { userId: "bob" });
      google("bob@example.test", true, "g-bob");
      const res = await connect(ctx, "google", "alice-session");
      expect(res.statusCode).toBe(409);
      expect(ctx.links.get("google|g-bob")?.userId).toBe("bob");
    });

    it("a Microsoft connect never marks the email verified", async () => {
      ctx.addUser({ userId: "carol", email: "carol@example.test", emailVerified: false, passwordHash: "x" });
      ctx.sessions.set("carol-session", "carol");
      microsoft("carol@example.test", "oid-carol", "tid-carol");
      await connect(ctx, "microsoft", "carol-session");
      expect(ctx.users.get("carol")!.emailVerified).toBe(false);
    });
  });
});

describe("oauth-identity helpers", () => {
  it("Google: email_verified must be true", () => {
    expect(oauthProfileFrom("google", { sub: "1", email: "a@x", email_verified: "true" }, null).emailVerified).toBe(true);
    expect(oauthProfileFrom("google", { sub: "1", email: "a@x" }, null).emailVerified).toBe(false);
    expect(oauthProfileFrom("google", { sub: "1", email: "a@x", email_verified: false }, { email: "a@x", email_verified: true }).emailVerified).toBe(true);
    expect(oauthProfileFrom("google", { sub: "1", email: "a@x", email_verified: false }, { email: "b@x", email_verified: true }).emailVerified).toBe(false);
  });

  it("Microsoft: never verified, even with email_verified or xms claims", () => {
    const p = oauthProfileFrom("microsoft", { sub: "s", oid: "o", tid: "t", email: "a@x", email_verified: true }, { email_verified: true });
    expect(p).toMatchObject({ subject: "t:o", tenantId: "t", legacySubject: "s", emailVerified: false });
  });

  it("decision table", () => {
    const verified = { emailVerified: true };
    const unverified = { emailVerified: false };
    const acct = (v: boolean) => ({ userId: "u", email: "a@x", emailVerified: v });
    expect(decideUnlinkedOauthLogin(verified, null).kind).toBe("create");
    expect(decideUnlinkedOauthLogin(unverified, null).kind).toBe("create");
    expect(decideUnlinkedOauthLogin(verified, acct(true)).kind).toBe("use_existing");
    expect(decideUnlinkedOauthLogin(unverified, acct(true)).kind).toBe("account_exists");
    expect(decideUnlinkedOauthLogin(verified, acct(false)).kind).toBe("account_unclaimed");
    expect(decideUnlinkedOauthLogin(unverified, acct(false)).kind).toBe("account_exists");
  });
});
