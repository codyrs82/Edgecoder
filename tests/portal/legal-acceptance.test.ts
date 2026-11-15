import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeJwtPayload, hashPassword, normalizeEmail, parseCookies, readCookie, sha256Hex, verifyPassword } from "../../src/portal/portal-utils.js";
import { OAUTH_STATE_COOKIE } from "../../src/portal/oauth-state-cookie.js";
import { HOST_AGREEMENT_VERSION, TERMS_VERSION } from "../../src/common/legal-notices.js";
import { registerLegalRoutes } from "../../src/portal/routes/legal.js";
import { memoryInviteStore } from "./invite-store-memory.js";

/*
 * Sign-up needs "I agree to the Terms, Privacy Policy and Acceptable Use Policy"; the accepted
 * version and time are stored on the account. Accounts made without it (SSO from an app) accept
 * later through /portal/api/legal, which also records the Host Agreement.
 */
const idp: { claims: Record<string, unknown> } = { claims: {} };
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const ok = (body: unknown) => ({ statusCode: 200, body: { json: async () => body, text: async () => JSON.stringify(body), dump: async () => {} } });
vi.mock("undici", () => ({
  request: vi.fn(async (url: string) => {
    if (url.endsWith("/token")) return ok({ access_token: "at", id_token: jwt(idp.claims) });
    if (url.endsWith("/userinfo")) return ok(idp.claims);
    return { statusCode: 404, body: { json: async () => ({}), text: async () => "", dump: async () => {} } };
  })
}));
const { registerAuthRoutes } = await import("../../src/portal/routes/auth.js");

type User = { userId: string; email: string; emailVerified: boolean; termsVersion?: string; termsAcceptedAtMs?: number; hostAgreementVersion?: string; hostAgreementAcceptedAtMs?: number };

function build() {
  const invites = memoryInviteStore();
  const users = new Map<string, User>();
  const states = new Map<string, Record<string, unknown>>();
  const links = new Map<string, string>();
  let currentUser: string | null = null;
  const store = {
    ...invites.store,
    getUserByEmail: async (email: string) => [...users.values()].find((u) => u.email === email) ?? null,
    getUserById: async (id: string) => users.get(id) ?? null,
    createUser: async (u: User) => {
      users.set(u.userId, { ...u });
      return { ...u, role: "user" };
    },
    createEmailVerification: async () => undefined,
    createOauthState: async (s: { stateId: string }) => void states.set(s.stateId, s),
    consumeOauthState: async (id: string) => {
      const s = states.get(id);
      states.delete(id);
      return s ?? null;
    },
    findOauthIdentity: async (p: string, sub: string) => (links.has(`${p}|${sub}`) ? { userId: links.get(`${p}|${sub}`)! } : null),
    linkOauthIdentity: async (l: { provider: string; providerSubject: string; userId: string }) => void links.set(`${l.provider}|${l.providerSubject}`, l.userId),
    markUserEmailVerified: async () => undefined,
    saveGitHubToken: async () => undefined,
    recordTermsAcceptance: async (userId: string, version: string, atMs: number) => Object.assign(users.get(userId)!, { termsVersion: version, termsAcceptedAtMs: atMs }),
    recordHostAgreementAcceptance: async (userId: string, version: string, atMs: number) => Object.assign(users.get(userId)!, { hostAgreementVersion: version, hostAgreementAcceptedAtMs: atMs }),
    getLegalAcceptance: async (userId: string) => {
      const u = users.get(userId);
      return u ? { termsVersion: u.termsVersion ?? null, termsAcceptedAtMs: u.termsAcceptedAtMs ?? null, hostAgreementVersion: u.hostAgreementVersion ?? null, hostAgreementAcceptedAtMs: u.hostAgreementAcceptedAtMs ?? null } : null;
    }
  };
  const cfg = { clientId: "id", clientSecret: "secret", scopes: "openid email", authorizeUrl: "https://google.idp.example/auth", tokenUrl: "https://google.idp.example/token", userinfoUrl: "https://google.idp.example/userinfo" };
  const app = Fastify();
  registerAuthRoutes(app, {
    store,
    LAUNCH_MODE: "open",
    oauthProviders: { google: cfg, microsoft: { ...cfg, clientId: "" }, github: { ...cfg, clientId: "" } },
    PORTAL_PUBLIC_URL: "https://portal.example",
    EMAIL_VERIFY_TTL_MS: 60_000,
    OAUTH_MICROSOFT_PROMPT: "",
    PASSKEY_ALLOWED_ORIGINS: [],
    normalizeNativeOauthRedirect: () => null,
    parseCookies,
    readCookie,
    normalizeEmail,
    decodeJwtPayload,
    sha256Hex,
    hashPassword,
    verifyPassword,
    clearCookies: () => [],
    ensureCreditAccountForUser: async () => {},
    sendVerificationEmail: async () => {},
    createSessionForUser: async () => "sess",
    getCurrentUser: async () => null,
    issueMobileOauthSessionToken: async () => "mobile"
  } as any);
  registerLegalRoutes(app, { store: store as any, getCurrentUser: async () => (currentUser ? { userId: currentUser } : null) });
  return { app, users, signIn: (id: string | null) => (currentUser = id) };
}

const signup = (ctx: ReturnType<typeof build>, extra: Record<string, unknown> = {}) =>
  ctx.app.inject({ method: "POST", url: "/auth/signup", payload: { email: "new@example.test", password: "correct-horse-1", ...extra } });

async function oauth(ctx: ReturnType<typeof build>, query = "") {
  const start = await ctx.app.inject({ url: `/auth/oauth/google/start${query}` });
  const state = new URL(String(start.headers.location)).searchParams.get("state")!;
  const cookie = ([] as string[]).concat(start.headers["set-cookie"] as string | string[]).find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`))!.split(";")[0];
  return ctx.app.inject({ url: `/auth/oauth/google/callback?code=c&state=${state}`, headers: { cookie } });
}

describe("sign-up requires accepting the Terms, Privacy Policy and Acceptable Use Policy", () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => (ctx = build()));

  it("refuses a sign-up without the checkbox and creates no account", async () => {
    for (const extra of [{}, { acceptTerms: false }]) {
      const res = await signup(ctx, extra);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("terms_not_accepted");
    }
    expect(ctx.users.size).toBe(0);
  });

  it("stores the accepted version and time on the account", async () => {
    const before = Date.now();
    const res = await signup(ctx, { acceptTerms: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().termsVersion).toBe(TERMS_VERSION);
    const user = ctx.users.get(res.json().userId)!;
    expect(user.termsVersion).toBe(TERMS_VERSION);
    expect(user.termsAcceptedAtMs).toBeGreaterThanOrEqual(before);
    expect(user.termsAcceptedAtMs).toBeLessThanOrEqual(Date.now());
  });

  it("single sign-on records the version the Create account checkbox passed, and only the current one", async () => {
    idp.claims = { sub: "g-1", email: "sso@example.test", email_verified: true };
    await oauth(ctx, `?terms=${encodeURIComponent(TERMS_VERSION)}`);
    expect([...ctx.users.values()].find((u) => u.email === "sso@example.test")!.termsVersion).toBe(TERMS_VERSION);

    idp.claims = { sub: "g-2", email: "old@example.test", email_verified: true };
    await oauth(ctx, "?terms=1999-01-01");
    expect([...ctx.users.values()].find((u) => u.email === "old@example.test")!.termsVersion).toBeUndefined();
  });
});

describe("/portal/api/legal", () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => (ctx = build()));

  it("needs a session", async () => {
    expect((await ctx.app.inject({ url: "/portal/api/legal" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "POST", url: "/portal/api/legal/accept", payload: { document: "terms", version: TERMS_VERSION } })).statusCode).toBe(401);
  });

  it("an SSO account without acceptance accepts the Terms later; the Host Agreement is recorded too", async () => {
    idp.claims = { sub: "g-3", email: "app@example.test", email_verified: true };
    await oauth(ctx);
    const user = [...ctx.users.values()].find((u) => u.email === "app@example.test")!;
    ctx.signIn(user.userId);
    let status = (await ctx.app.inject({ url: "/portal/api/legal" })).json();
    expect(status).toMatchObject({ current: { terms: TERMS_VERSION, hostAgreement: HOST_AGREEMENT_VERSION }, termsCurrent: false, hostAgreementCurrent: false });

    const stale = await ctx.app.inject({ method: "POST", url: "/portal/api/legal/accept", payload: { document: "terms", version: "1999-01-01" } });
    expect(stale.statusCode).toBe(409);
    expect(user.termsVersion).toBeUndefined();

    expect((await ctx.app.inject({ method: "POST", url: "/portal/api/legal/accept", payload: { document: "terms", version: TERMS_VERSION } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: "/portal/api/legal/accept", payload: { document: "host-agreement", version: HOST_AGREEMENT_VERSION } })).statusCode).toBe(200);
    status = (await ctx.app.inject({ url: "/portal/api/legal" })).json();
    expect(status).toMatchObject({ termsCurrent: true, hostAgreementCurrent: true, accepted: { termsVersion: TERMS_VERSION, hostAgreementVersion: HOST_AGREEMENT_VERSION } });
    expect(typeof status.accepted.hostAgreementAcceptedAtMs).toBe("number");
    expect((await ctx.app.inject({ method: "POST", url: "/portal/api/legal/accept", payload: { document: "cookies", version: "x" } })).statusCode).toBe(400);
  });
});
