import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeJwtPayload, normalizeEmail, parseCookies, readCookie, sha256Hex } from "../../src/portal/portal-utils.js";
import { OAUTH_STATE_COOKIE } from "../../src/portal/oauth-state-cookie.js";
import { MICROSOFT_CONSUMER_TENANT_ID, decideUnlinkedOauthLogin, microsoftUpnOnVerifiedDomain, oauthProfileFrom } from "../../src/portal/oauth-identity.js";
import { LINK_BROWSER_COOKIE, LINK_MAX_PER_ACCOUNT, LINK_MAX_PER_IP } from "../../src/portal/oauth-pending-link.js";

/** What the fake identity provider answers for the current test. */
const idp: { idClaims: Record<string, unknown> | null; userInfo: Record<string, unknown> | null; githubEmails: unknown; organization: unknown } = {
  idClaims: null,
  userInfo: null,
  githubEmails: null,
  organization: null
};
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const ok = (body: unknown) => ({ statusCode: 200, body: { json: async () => body, text: async () => JSON.stringify(body), dump: async () => {} } });

vi.mock("undici", () => ({
  request: vi.fn(async (url: string) => {
    if (url.endsWith("/token")) return ok({ access_token: "at", ...(idp.idClaims ? { id_token: jwt(idp.idClaims) } : {}) });
    if (url.endsWith("/userinfo")) return ok(idp.userInfo ?? {});
    if (url === "https://api.github.com/user/emails") return ok(idp.githubEmails ?? []);
    if (url.startsWith("https://graph.microsoft.com/v1.0/organization")) {
      if (idp.organization) return ok(idp.organization);
      return { statusCode: 403, body: { json: async () => ({}), text: async () => "", dump: async () => {} } };
    }
    return { statusCode: 404, body: { json: async () => ({}), text: async () => "", dump: async () => {} } };
  })
}));
const { registerAuthRoutes } = await import("../../src/portal/routes/auth.js");

type User = { userId: string; email: string; emailVerified: boolean; passwordHash?: string; role: "user" | "admin" };

type PendingRow = { kind: string; userId: string; provider: string; providerSubject: string; tenantId?: string; email: string; browserHash?: string; ipHash?: string; expiresAtMs: number; consumedAtMs?: number; createdAtMs: number };

function build(opts: { nativeRedirect?: string } = {}) {
  const users = new Map<string, User>();
  const pending = new Map<string, PendingRow>();
  const passkeys = new Map<string, number>();
  const mail = {
    confirm: [] as Array<{ email: string; providerLabel: string; token: string }>,
    connected: [] as Array<{ email: string; providerLabel: string }>,
    claim: [] as Array<{ email: string; providerLabel: string }>
  };
  const links = new Map<string, { userId: string; tenantId?: string; email?: string }>();
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
    listOauthLinksForUser: vi.fn(async (userId: string) =>
      [...links.entries()].filter(([, l]) => l.userId === userId).map(([k, l]) => ({ provider: k.split("|")[0], providerSubject: k.slice(k.indexOf("|") + 1), createdAtMs: 1, ...(l.email ? { emailSnapshot: l.email } : {}) }))
    ),
    deleteOauthLink: vi.fn(async (userId: string, provider: string, subject: string) => {
      const l = links.get(`${provider}|${subject}`);
      if (!l || l.userId !== userId) return false;
      links.delete(`${provider}|${subject}`);
      return true;
    }),
    listPasskeysByUserId: vi.fn(async (userId: string) => Array.from({ length: passkeys.get(userId) ?? 0 }, () => ({}))),
    createOauthPendingLink: vi.fn(async (r: PendingRow & { tokenHash: string }) => {
      const { tokenHash, ...row } = r;
      pending.set(tokenHash, { ...row, createdAtMs: Date.now() });
    }),
    countRecentOauthPendingLinksForUser: vi.fn(async (userId: string, since: number) => [...pending.values()].filter((r) => r.userId === userId && r.createdAtMs >= since).length),
    countRecentOauthPendingLinksFromIp: vi.fn(async (ipHash: string, since: number) => [...pending.values()].filter((r) => r.ipHash === ipHash && r.createdAtMs >= since).length),
    findOauthPendingLink: vi.fn(async (hash: string) => {
      const r = pending.get(hash);
      return r && r.kind === "link" && !r.consumedAtMs && r.expiresAtMs > Date.now() ? { ...r } : null;
    }),
    consumeOauthPendingLink: vi.fn(async (hash: string) => {
      const r = pending.get(hash);
      if (!r || r.kind !== "link" || r.consumedAtMs || r.expiresAtMs <= Date.now()) return null;
      r.consumedAtMs = Date.now();
      return { ...r };
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
    normalizeNativeOauthRedirect: (v?: string) => (opts.nativeRedirect && v ? opts.nativeRedirect : null),
    sha256Hex,
    clientIp: (req: { ip: string }) => req.ip,
    sendOauthLinkConfirmEmail: vi.fn(async (m: { email: string; providerLabel: string; token: string }) => (mail.confirm.push(m), true)),
    sendOauthConnectedEmail: vi.fn(async (m: { email: string; providerLabel: string }) => (mail.connected.push(m), true)),
    sendOauthLinkClaimNoticeEmail: vi.fn(async (m: { email: string; providerLabel: string }) => (mail.claim.push(m), true)),
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
  return { app, store, users, links, sessions, githubTokens, addUser, pending, passkeys, mail };
}

type Ctx = ReturnType<typeof build>;

function stateCookie(res: { headers: Record<string, unknown> }) {
  return ([] as string[]).concat(res.headers["set-cookie"] as string | string[]).find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`))!.split(";")[0];
}

/** Runs /start + /callback and returns the callback response and the session it created, if any. */
async function signIn(ctx: Ctx, provider: string, opts: { ip?: string; query?: string } = {}) {
  const start = await ctx.app.inject({ url: `/auth/oauth/${provider}/start${opts.query ?? ""}` });
  const state = new URL(String(start.headers.location)).searchParams.get("state")!;
  const before = new Set(ctx.sessions.keys());
  const res = await ctx.app.inject({ url: `/auth/oauth/${provider}/callback?code=c&state=${state}`, headers: { cookie: stateCookie(start) }, ...(opts.ip ? { remoteAddress: opts.ip } : {}) });
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
const microsoft = (email: string, oid = "oid-1", tid = "tid-1", sub = "ms-sub-1", extra: Record<string, unknown> = {}) => {
  idp.idClaims = { sub, oid, tid, email, ...extra };
  idp.userInfo = { sub, email };
  idp.githubEmails = null;
  idp.organization = null;
};

describe("OAuth sign-in links only by a provider-verified email", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = build();
    ctx.addUser({ userId: "alice", email: "alice@example.test", emailVerified: true, passwordHash: "x" });
  });

  describe("google", () => {
    it("verified email links to the existing verified account, and the account is emailed a notice", async () => {
      google("ALICE@example.test", true);
      const { res, sessionUser } = await signIn(ctx, "google");
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/portal/dashboard?sso_connected=google");
      expect(sessionUser).toBe("alice");
      expect(ctx.links.get("google|g-1")?.userId).toBe("alice");
      expect(ctx.mail.connected).toEqual([{ email: "alice@example.test", providerLabel: "Google" }]);
      expect(ctx.mail.confirm).toHaveLength(0);
    });

    it("unverified email does not link: the account's inbox is asked to confirm (no session)", async () => {
      google("alice@example.test", false);
      const { res, sessionUser } = await signIn(ctx, "google");
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("We sent a link to a…@example.test to connect Google to your account.");
      expect(res.body).toContain("Sign in with password instead");
      expect(sessionUser).toBeUndefined();
      expect(ctx.links.size).toBe(0);
      expect(ctx.mail.confirm).toHaveLength(1);
      expect(ctx.mail.confirm[0]).toMatchObject({ email: "alice@example.test", providerLabel: "Google" });
      expect(ctx.mail.connected).toHaveLength(0);
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
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("to connect GitHub to your account");
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
    it("without proof of the address: never signed in, the account's inbox confirms instead", async () => {
      microsoft("alice@example.test");
      const { res, sessionUser } = await signIn(ctx, "microsoft");
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("We sent a link to a…@example.test to connect Microsoft to your account.");
      expect(sessionUser).toBeUndefined();
      expect(ctx.links.size).toBe(0);
      expect(ctx.mail.confirm).toHaveLength(1);
      const row = [...ctx.pending.values()][0];
      expect(row).toMatchObject({ kind: "link", userId: "alice", provider: "microsoft", providerSubject: "tid-1:oid-1", tenantId: "tid-1", email: "alice@example.test" });
      // Only the hash is kept.
      expect(ctx.pending.has(ctx.mail.confirm[0].token)).toBe(false);
      expect(ctx.pending.has(sha256Hex(ctx.mail.confirm[0].token))).toBe(true);
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
      expect(res.statusCode).toBe(200);
      expect(sessionUser).toBeUndefined();
      expect(ctx.links.get("microsoft|tid-B:oid-1")).toBeUndefined();
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
        // Same screen as a confirmation link (no more disclosure); the inbox gets a claim notice, no link.
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain("We sent a link to v…@example.test");
        expect(ctx.mail.claim).toHaveLength(1);
        expect(ctx.mail.confirm).toHaveLength(0);
        expect(sessionUser).toBeUndefined();
        expect(ctx.users.get("squatter")!.emailVerified).toBe(false);
        expect(ctx.links.size).toBe(0);
        expect(ctx.githubTokens.has("squatter")).toBe(false);
      });
    }

    it("microsoft: refused as well (claim notice, nothing linked)", async () => {
      microsoft("victim@example.test", "oid-v", "tid-v", "s-v", { xms_edov: true });
      const { res, sessionUser } = await signIn(ctx, "microsoft");
      expect(res.statusCode).toBe(200);
      expect(sessionUser).toBeUndefined();
      expect(ctx.links.size).toBe(0);
      expect(ctx.mail.claim).toHaveLength(1);
      expect(ctx.users.get("squatter")!.emailVerified).toBe(false);
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
      const res = await connect(ctx, "microsoft", "carol-session");
      expect(ctx.users.get("carol")!.emailVerified).toBe(false);
      // An unverified account gains no sign-in method that does not prove its address.
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain("Verify your email address");
      expect(ctx.links.size).toBe(0);
    });

    it("an unverified account can connect a provider that proves its address (and is verified)", async () => {
      ctx.addUser({ userId: "dave", email: "dave@example.test", emailVerified: false, passwordHash: "x" });
      ctx.sessions.set("dave-session", "dave");
      google("dave@example.test", true, "g-dave");
      const res = await connect(ctx, "google", "dave-session");
      expect(res.statusCode).toBe(302);
      expect(ctx.links.get("google|g-dave")?.userId).toBe("dave");
      expect(ctx.users.get("dave")!.emailVerified).toBe(true);
    });

    it("an unverified account cannot connect GitHub with another address (no token is stored)", async () => {
      ctx.addUser({ userId: "erin", email: "erin@example.test", emailVerified: false, passwordHash: "x" });
      ctx.sessions.set("erin-session", "erin");
      github([{ email: "someone-else@example.test", primary: true, verified: true }]);
      const res = await connect(ctx, "github", "erin-session");
      expect(res.statusCode).toBe(403);
      expect(ctx.githubTokens.has("erin")).toBe(false);
    });
  });
});

describe("connecting a provider to an existing account (automatic or by email)", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = build();
    ctx.addUser({ userId: "cody", email: "cody@bigdigital.energy", emailVerified: true, passwordHash: "x" });
  });

  /** The browser-binding cookie the callback set, as a Cookie header value. */
  const linkCookie = (res: { headers: Record<string, unknown> }) =>
    ([] as string[]).concat((res.headers["set-cookie"] as string | string[]) ?? []).find((c) => c.startsWith(`${LINK_BROWSER_COOKIE}=`))?.split(";")[0];
  const confirm = (token: string, cookie?: string) =>
    ctx.app.inject({ method: "POST", url: "/auth/oauth-link/confirm", payload: { token }, ...(cookie ? { headers: { cookie } } : {}) });

  it("Microsoft with xms_edov=true links automatically, signs in and emails a security notice", async () => {
    microsoft("cody@bigdigital.energy", "oid-c", "tid-bde", "s", { xms_edov: true });
    const { res, sessionUser } = await signIn(ctx, "microsoft");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/portal/dashboard?sso_connected=microsoft");
    expect(sessionUser).toBe("cody");
    expect(ctx.links.get("microsoft|tid-bde:oid-c")).toEqual({ userId: "cody", tenantId: "tid-bde" });
    expect(ctx.mail.connected).toEqual([{ email: "cody@bigdigital.energy", providerLabel: "Microsoft" }]);
  });

  it("Microsoft work account without xms_edov: the UPN on a verified domain of its tenant links automatically", async () => {
    microsoft("cody@bigdigital.energy", "oid-c", "tid-bde", "s", { preferred_username: "cody@bigdigital.energy" });
    idp.organization = { value: [{ id: "tid-bde", verifiedDomains: [{ name: "bigdigital.energy" }] }] };
    const { res, sessionUser } = await signIn(ctx, "microsoft");
    expect(res.statusCode).toBe(302);
    expect(sessionUser).toBe("cody");
    expect(ctx.mail.connected).toHaveLength(1);
  });

  it("Microsoft work account without xms_edov whose tenant domains cannot be read: email confirmation", async () => {
    microsoft("cody@bigdigital.energy", "oid-c", "tid-bde", "s", { preferred_username: "cody@bigdigital.energy" });
    const { res, sessionUser } = await signIn(ctx, "microsoft");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("We sent a link to c…@bigdigital.energy to connect Microsoft to your account.");
    expect(sessionUser).toBeUndefined();
    expect(ctx.links.size).toBe(0);
  });

  it("Microsoft: a domain verified by another tenant does not count", async () => {
    microsoft("cody@bigdigital.energy", "oid-x", "tid-evil", "s", { preferred_username: "cody@bigdigital.energy" });
    idp.organization = { value: [{ id: "tid-bde", verifiedDomains: [{ name: "bigdigital.energy" }] }] };
    const { res } = await signIn(ctx, "microsoft");
    expect(res.statusCode).toBe(200);
    expect(ctx.links.size).toBe(0);
  });

  it("a personal Microsoft account (consumer tenant) goes to email confirmation, even with xms_edov", async () => {
    microsoft("cody@bigdigital.energy", "oid-p", MICROSOFT_CONSUMER_TENANT_ID, "s", { xms_edov: true, preferred_username: "cody@bigdigital.energy" });
    idp.organization = { value: [{ id: MICROSOFT_CONSUMER_TENANT_ID, verifiedDomains: [{ name: "bigdigital.energy" }] }] };
    const { res, sessionUser } = await signIn(ctx, "microsoft");
    expect(res.statusCode).toBe(200);
    expect(sessionUser).toBeUndefined();
    expect(ctx.mail.confirm).toHaveLength(1);
  });

  it("the emailed link, opened in the same browser, links and signs in; it works once", async () => {
    microsoft("cody@bigdigital.energy", "oid-c", "tid-bde");
    const { res } = await signIn(ctx, "microsoft");
    const cookie = linkCookie(res)!;
    expect(cookie).toBeDefined();
    expect(String(res.headers["set-cookie"])).toContain("HttpOnly");
    const token = ctx.mail.confirm[0].token;

    // Opening the link changes nothing.
    const page = await ctx.app.inject({ url: `/auth/oauth-link/confirm?token=${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain(token);
    expect(ctx.links.size).toBe(0);

    const before = new Set(ctx.sessions.keys());
    const done = await confirm(token, cookie);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: "linked", provider: "microsoft", next: "/portal/dashboard?sso_connected=microsoft" });
    expect(ctx.links.get("microsoft|tid-bde:oid-c")).toEqual({ userId: "cody", tenantId: "tid-bde" });
    expect([...ctx.sessions.entries()].find(([k]) => !before.has(k))?.[1]).toBe("cody");
    expect(ctx.mail.connected).toEqual([{ email: "cody@bigdigital.energy", providerLabel: "Microsoft" }]);
    // The next sign-in with Microsoft goes straight in.
    expect((await signIn(ctx, "microsoft")).sessionUser).toBe("cody");

    // Single use.
    const again = await confirm(token, cookie);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe("oauth_link_invalid");
  });

  it("an expired link is refused", async () => {
    microsoft("cody@bigdigital.energy", "oid-c", "tid-bde");
    const { res } = await signIn(ctx, "microsoft");
    const token = ctx.mail.confirm[0].token;
    ctx.pending.get(sha256Hex(token))!.expiresAtMs = Date.now() - 1;
    const done = await confirm(token, linkCookie(res));
    expect(done.statusCode).toBe(400);
    expect(ctx.links.size).toBe(0);
  });

  it("a link is valid for 15 minutes", async () => {
    microsoft("cody@bigdigital.energy", "oid-c", "tid-bde");
    const t0 = Date.now();
    await signIn(ctx, "microsoft");
    const row = ctx.pending.get(sha256Hex(ctx.mail.confirm[0].token))!;
    expect(row.expiresAtMs - t0).toBeGreaterThan(14 * 60 * 1000);
    expect(row.expiresAtMs - t0).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
  });

  it("another browser must sign in with the same provider identity; a different identity cannot use the link", async () => {
    microsoft("cody@bigdigital.energy", "oid-c", "tid-bde");
    await signIn(ctx, "microsoft");
    const token = ctx.mail.confirm[0].token;

    // No cookie (another device), or someone else's cookie: re-authentication required.
    const other = await confirm(token, `${LINK_BROWSER_COOKIE}=not-the-right-one`);
    expect(other.statusCode).toBe(200);
    const body = other.json();
    expect(body.status).toBe("reauth_required");
    expect(ctx.links.size).toBe(0);

    // The attacker's own Microsoft account: refused, nothing linked.
    microsoft("cody@bigdigital.energy", "oid-attacker", "tid-evil");
    const state = new URL(body.authorizeUrl).searchParams.get("state")!;
    const wrong = await ctx.app.inject({ url: `/auth/oauth/microsoft/callback?code=c&state=${state}`, headers: { cookie: stateCookie(other) } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.body).toContain("not the Microsoft account waiting to be connected");
    expect(ctx.links.size).toBe(0);

    // The identity the link was made for completes it.
    const retry = await confirm(token);
    microsoft("cody@bigdigital.energy", "oid-c", "tid-bde");
    const state2 = new URL(retry.json().authorizeUrl).searchParams.get("state")!;
    const right = await ctx.app.inject({ url: `/auth/oauth/microsoft/callback?code=c&state=${state2}`, headers: { cookie: stateCookie(retry) } });
    expect(right.statusCode).toBe(302);
    expect(right.headers.location).toBe("/portal/dashboard?sso_connected=microsoft");
    expect(ctx.links.get("microsoft|tid-bde:oid-c")?.userId).toBe("cody");
    // ...once.
    expect((await confirm(token)).statusCode).toBe(400);
  });

  it("the link is not completed if the account's address changed or the identity was linked elsewhere meanwhile", async () => {
    microsoft("cody@bigdigital.energy", "oid-c", "tid-bde");
    const { res } = await signIn(ctx, "microsoft");
    ctx.links.set("microsoft|tid-bde:oid-c", { userId: "someone-else" });
    const done = await confirm(ctx.mail.confirm[0].token, linkCookie(res));
    expect(done.statusCode).toBe(409);
    expect(ctx.links.get("microsoft|tid-bde:oid-c")?.userId).toBe("someone-else");
  });

  it("caps confirmation emails per account", async () => {
    microsoft("cody@bigdigital.energy", "oid-c", "tid-bde");
    for (let i = 0; i < LINK_MAX_PER_ACCOUNT; i++) {
      expect((await signIn(ctx, "microsoft", { ip: `198.51.100.${i + 1}` })).res.statusCode).toBe(200);
    }
    const limited = await signIn(ctx, "microsoft", { ip: "198.51.100.99" });
    expect(limited.res.statusCode).toBe(429);
    expect(limited.res.body).toContain("sign in with your password instead");
    expect(ctx.mail.confirm).toHaveLength(LINK_MAX_PER_ACCOUNT);
  });

  it("caps pending links per client address, across accounts", async () => {
    for (let i = 0; i < LINK_MAX_PER_IP + 1; i++) {
      ctx.addUser({ userId: `u${i}`, email: `user${i}@example.test`, emailVerified: true, passwordHash: "x" });
    }
    const statuses: number[] = [];
    for (let i = 0; i < LINK_MAX_PER_IP + 1; i++) {
      microsoft(`user${i}@example.test`, `oid-${i}`, "tid-1");
      statuses.push((await signIn(ctx, "microsoft", { ip: "203.0.113.50" })).res.statusCode);
    }
    expect(statuses.slice(0, LINK_MAX_PER_IP).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect(ctx.mail.confirm).toHaveLength(LINK_MAX_PER_IP);
  });

  it("the desktop app gets a link_pending deep link with the masked address (and the browser keeps the cookie)", async () => {
    ctx = build({ nativeRedirect: "edgecoder://oauth-callback" });
    ctx.addUser({ userId: "cody", email: "cody@bigdigital.energy", emailVerified: true, passwordHash: "x" });
    microsoft("cody@bigdigital.energy", "oid-c", "tid-bde");
    const { res, sessionUser } = await signIn(ctx, "microsoft", { query: "?appRedirect=edgecoder%3A%2F%2Foauth-callback" });
    expect(res.statusCode).toBe(302);
    const deep = new URL(String(res.headers.location));
    expect(deep.protocol).toBe("edgecoder:");
    expect(deep.searchParams.get("status")).toBe("link_pending");
    expect(deep.searchParams.get("provider")).toBe("microsoft");
    expect(deep.searchParams.get("email_hint")).toBe("c…@bigdigital.energy");
    expect(deep.searchParams.has("mobile_token")).toBe(false);
    expect(linkCookie(res)).toBeDefined();
    expect(sessionUser).toBeUndefined();
  });

  it("the desktop app is told when the provider was connected automatically", async () => {
    ctx = build({ nativeRedirect: "edgecoder://oauth-callback" });
    ctx.addUser({ userId: "cody", email: "cody@bigdigital.energy", emailVerified: true, passwordHash: "x" });
    google("cody@bigdigital.energy", true, "g-c");
    const { res } = await signIn(ctx, "google", { query: "?appRedirect=edgecoder%3A%2F%2Foauth-callback" });
    const deep = new URL(String(res.headers.location));
    expect(deep.searchParams.get("status")).toBe("ok");
    expect(deep.searchParams.get("linked")).toBe("1");
    expect(ctx.mail.connected).toHaveLength(1);
  });
});

describe("Connected sign-ins (Settings)", () => {
  let ctx: Ctx;
  const session = { cookie: "edgecoder_portal_session=s-1" };
  beforeEach(() => {
    ctx = build();
  });
  const list = () => ctx.app.inject({ url: "/portal/api/sign-ins", headers: session });
  const remove = (provider: string, linkId: string) => ctx.app.inject({ method: "DELETE", url: `/portal/api/sign-ins/${provider}/${linkId}`, headers: session, payload: {} });

  it("lists the connected providers without exposing the provider subject", async () => {
    ctx.addUser({ userId: "u", email: "u@example.test", emailVerified: true, passwordHash: "x" });
    ctx.sessions.set("s-1", "u");
    ctx.links.set("microsoft|tid:oid", { userId: "u", email: "u@example.test" });
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ password: true, passkeys: 0, providers: [{ provider: "microsoft", label: "Microsoft", email: "u@example.test" }] });
    expect(res.body).not.toContain("tid:oid");
  });

  it("refuses to remove the last sign-in method", async () => {
    ctx.addUser({ userId: "u", email: "u@example.test", emailVerified: true });
    ctx.sessions.set("s-1", "u");
    ctx.links.set("microsoft|tid:oid", { userId: "u" });
    const { providers } = (await list()).json();
    const res = await remove("microsoft", providers[0].linkId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("last_sign_in_method");
    expect(ctx.links.has("microsoft|tid:oid")).toBe(true);
  });

  it("removes a provider when another way in remains (password, passkey or another provider)", async () => {
    ctx.addUser({ userId: "u", email: "u@example.test", emailVerified: true });
    ctx.sessions.set("s-1", "u");
    ctx.links.set("microsoft|tid:oid", { userId: "u" });
    ctx.passkeys.set("u", 1);
    const { providers } = (await list()).json();
    const res = await remove("microsoft", providers[0].linkId);
    expect(res.statusCode).toBe(200);
    expect(ctx.links.has("microsoft|tid:oid")).toBe(false);
  });

  it("cannot remove another account's link, and needs a session", async () => {
    ctx.addUser({ userId: "u", email: "u@example.test", emailVerified: true, passwordHash: "x" });
    ctx.addUser({ userId: "v", email: "v@example.test", emailVerified: true, passwordHash: "x" });
    ctx.sessions.set("s-1", "u");
    ctx.links.set("google|g-v", { userId: "v" });
    const res = await remove("google", sha256Hex("google|g-v").slice(0, 32));
    expect(res.statusCode).toBe(404);
    expect(ctx.links.has("google|g-v")).toBe(true);
    expect((await ctx.app.inject({ url: "/portal/api/sign-ins" })).statusCode).toBe(401);
  });
});

describe("oauth-identity helpers", () => {
  it("Google: email_verified must be true", () => {
    expect(oauthProfileFrom("google", { sub: "1", email: "a@x", email_verified: "true" }, null).emailVerified).toBe(true);
    expect(oauthProfileFrom("google", { sub: "1", email: "a@x" }, null).emailVerified).toBe(false);
    expect(oauthProfileFrom("google", { sub: "1", email: "a@x", email_verified: false }, { email: "a@x", email_verified: true }).emailVerified).toBe(true);
    expect(oauthProfileFrom("google", { sub: "1", email: "a@x", email_verified: false }, { email: "b@x", email_verified: true }).emailVerified).toBe(false);
  });

  it("Microsoft: email_verified is ignored; only xms_edov (work/school tenant) proves the address", () => {
    const p = oauthProfileFrom("microsoft", { sub: "s", oid: "o", tid: "t", email: "a@x", email_verified: true }, { email_verified: true });
    expect(p).toMatchObject({ subject: "t:o", tenantId: "t", legacySubject: "s", emailVerified: false });
    expect(oauthProfileFrom("microsoft", { oid: "o", tid: "t", email: "a@x", xms_edov: true }, null).emailVerified).toBe(true);
    expect(oauthProfileFrom("microsoft", { oid: "o", tid: "t", email: "a@x", xms_edov: false }, null).emailVerified).toBe(false);
    // xms_edov vouches for the `email` claim only, never for preferred_username.
    expect(oauthProfileFrom("microsoft", { oid: "o", tid: "t", preferred_username: "a@x", xms_edov: true }, null).emailVerified).toBe(false);
    // Personal accounts: never verified, and no tenant-domain check.
    const consumer = oauthProfileFrom("microsoft", { oid: "o", tid: MICROSOFT_CONSUMER_TENANT_ID, email: "a@outlook.com", preferred_username: "a@outlook.com", xms_edov: true }, null);
    expect(consumer.emailVerified).toBe(false);
    expect(consumer.microsoftDomainCandidate).toBeUndefined();
    // Work account without xms_edov: the UPN is a candidate for the tenant-domain check.
    expect(oauthProfileFrom("microsoft", { oid: "o", tid: "t", email: "a@x.test", preferred_username: "a@x.test" }, null).microsoftDomainCandidate).toBe("a@x.test");
  });

  it("Microsoft UPN domain must be an exact verified domain of the same tenant", () => {
    const org = { value: [{ id: "TID-1", verifiedDomains: [{ name: "BigDigital.Energy" }, { name: "contoso.onmicrosoft.com" }] }] };
    expect(microsoftUpnOnVerifiedDomain("c@bigdigital.energy", "tid-1", org)).toBe(true);
    expect(microsoftUpnOnVerifiedDomain("c@mail.bigdigital.energy", "tid-1", org)).toBe(false);
    expect(microsoftUpnOnVerifiedDomain("c@bigdigital.energy", "tid-2", org)).toBe(false);
    expect(microsoftUpnOnVerifiedDomain("c@bigdigital.energy", "tid-1", null)).toBe(false);
    expect(microsoftUpnOnVerifiedDomain("c@bigdigital.energy", "tid-1", { value: [{ id: "tid-1" }] })).toBe(false);
    expect(microsoftUpnOnVerifiedDomain("no-at-sign", "tid-1", org)).toBe(false);
  });

  it("decision table", () => {
    const verified = { emailVerified: true };
    const unverified = { emailVerified: false };
    const acct = (v: boolean) => ({ userId: "u", email: "a@x", emailVerified: v });
    expect(decideUnlinkedOauthLogin(verified, null).kind).toBe("create");
    expect(decideUnlinkedOauthLogin(unverified, null).kind).toBe("create");
    expect(decideUnlinkedOauthLogin({ ...verified, email: "A@x" }, acct(true)).kind).toBe("use_existing");
    // Verified, but for another address than the account's: not proof for this account.
    expect(decideUnlinkedOauthLogin({ ...verified, email: "b@x" }, acct(true)).kind).toBe("confirm_by_email");
    expect(decideUnlinkedOauthLogin(unverified, acct(true)).kind).toBe("confirm_by_email");
    expect(decideUnlinkedOauthLogin(verified, acct(false)).kind).toBe("account_unclaimed");
    expect(decideUnlinkedOauthLogin(unverified, acct(false)).kind).toBe("account_unclaimed");
  });
});
