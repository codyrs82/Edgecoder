import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeJwtPayload, hashPassword, normalizeEmail, parseCookies, readCookie, sha256Hex, verifyPassword } from "../../src/portal/portal-utils.js";
import { OAUTH_STATE_COOKIE } from "../../src/portal/oauth-state-cookie.js";
import { generateInviteCode, inviteCodeHash } from "../../src/portal/invites.js";
import { registerAgentRoutes } from "../../src/portal/routes/agents.js";
import { memoryInviteStore } from "./invite-store-memory.js";
import { fakeStore } from "./fake-agent-store.js";

/*
 * Soft launch (LAUNCH_MODE=invite): every way an account is created needs an invite code
 * (email signup, first OAuth sign-in, a new AI-agent key); existing accounts are grandfathered.
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

type User = { userId: string; email: string; emailVerified: boolean; passwordHash?: string; role: "user" };

function build(mode: "open" | "invite") {
  const invites = memoryInviteStore();
  const users = new Map<string, User>();
  const states = new Map<string, Record<string, unknown>>();
  const links = new Map<string, string>();
  const sessions = new Map<string, string>();
  let n = 0;
  const store = {
    ...invites.store,
    getUserByEmail: async (email: string) => [...users.values()].find((u) => u.email === email) ?? null,
    getUserById: async (id: string) => users.get(id) ?? null,
    createUser: async (u: { userId: string; email: string; emailVerified: boolean; passwordHash?: string }) => {
      const user = { ...u, role: "user" as const };
      users.set(u.userId, user);
      return user;
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
    saveGitHubToken: async () => undefined
  };
  const cfg = { clientId: "id", clientSecret: "secret", scopes: "openid email", authorizeUrl: "https://google.idp.example/auth", tokenUrl: "https://google.idp.example/token", userinfoUrl: "https://google.idp.example/userinfo" };
  const app = Fastify();
  registerAuthRoutes(app, {
    store,
    LAUNCH_MODE: mode,
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
    createSessionForUser: async (userId: string) => {
      const token = `sess-${++n}`;
      sessions.set(token, userId);
      return token;
    },
    getCurrentUser: async () => null,
    issueMobileOauthSessionToken: async () => "mobile"
  } as any);
  const mint = async (maxUses = 1) => {
    const code = generateInviteCode();
    await invites.store.createInviteCode({ codeId: `${Math.random().toString(16).slice(2)}`.padEnd(24, "0").slice(0, 24), codeHash: inviteCodeHash(code), prefix: code.slice(0, 7), label: null, maxUses, expiresAtMs: null, createdBy: "admin", createdAtMs: 1 });
    return code;
  };
  return { app, users, links, sessions, invites, mint };
}

const signup = (ctx: ReturnType<typeof build>, extra: Record<string, unknown> = {}) =>
  ctx.app.inject({ method: "POST", url: "/auth/signup", payload: { email: "new@example.test", password: "correct-horse-1", ...extra } });

async function oauth(ctx: ReturnType<typeof build>, query = "") {
  const start = await ctx.app.inject({ url: `/auth/oauth/google/start${query}` });
  if (start.statusCode !== 302) return { start, res: null };
  const state = new URL(String(start.headers.location)).searchParams.get("state")!;
  const cookie = ([] as string[]).concat(start.headers["set-cookie"] as string | string[]).find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`))!.split(";")[0];
  const res = await ctx.app.inject({ url: `/auth/oauth/google/callback?code=c&state=${state}`, headers: { cookie } });
  return { start, res };
}

describe("email signup in invite mode", () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => (ctx = build("invite")));

  it("says so in /auth/capabilities", async () => {
    expect((await ctx.app.inject({ url: "/auth/capabilities" })).json().launch).toEqual({ mode: "invite", inviteRequired: true });
    expect((await build("open").app.inject({ url: "/auth/capabilities" })).json().launch).toEqual({ mode: "open", inviteRequired: false });
  });

  it("refuses a signup without a code or with a bad one, and creates no account", async () => {
    const none = await signup(ctx);
    expect(none.statusCode).toBe(403);
    expect(none.json().error).toBe("invite_required");
    expect((await signup(ctx, { inviteCode: "EC-AAAA-BBBB-CCCC-DDDD" })).json().error).toBe("invite_invalid");
    expect(ctx.users.size).toBe(0);
  });

  it("creates the account with a live code and uses it up", async () => {
    const code = await ctx.mint(1);
    const res = await signup(ctx, { inviteCode: code.toLowerCase() });
    expect(res.statusCode).toBe(200);
    expect(ctx.invites.redemptions).toEqual([{ codeId: expect.any(String), userId: res.json().userId }]);
    expect((await signup(ctx, { email: "second@example.test", inviteCode: code })).json().error).toBe("invite_invalid");
  });

  it("does not spend a use on an address that is already registered", async () => {
    const code = await ctx.mint(1);
    expect((await signup(ctx, { inviteCode: code })).statusCode).toBe(200);
    const again = await signup(ctx, { inviteCode: code });
    expect(again.statusCode).toBe(409);
  });

  it("existing accounts still sign in", async () => {
    ctx.users.set("old", { userId: "old", email: "old@example.test", emailVerified: true, passwordHash: hashPassword("old-password-1"), role: "user" });
    expect((await ctx.app.inject({ method: "POST", url: "/auth/login", payload: { email: "old@example.test", password: "old-password-1" } })).statusCode).toBe(200);
  });

  it("open mode needs no code", async () => {
    expect((await signup(build("open"))).statusCode).toBe(200);
  });
});

describe("OAuth sign-up in invite mode", () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build("invite");
    idp.claims = { sub: "g-new", email: "fresh@example.test", email_verified: true };
  });

  it("a first sign-in without a code creates no account", async () => {
    const { res } = await oauth(ctx);
    expect(res!.statusCode).toBe(403);
    expect(res!.body).toContain("invite");
    expect(ctx.users.size).toBe(0);
  });

  it("a bad code is refused at the start", async () => {
    const { start } = await oauth(ctx, "?invite=EC-AAAA-BBBB-CCCC-DDDD");
    expect(start.statusCode).toBe(403);
  });

  it("a code given at the start is used when the account is created", async () => {
    const code = await ctx.mint(1);
    const { res } = await oauth(ctx, `?invite=${encodeURIComponent(code)}`);
    expect(res!.statusCode).toBe(302);
    expect(ctx.users.size).toBe(1);
    expect(ctx.invites.redemptions).toHaveLength(1);
  });

  it("an existing account signs in without a code, and a code given is not spent", async () => {
    ctx.users.set("old", { userId: "old", email: "fresh@example.test", emailVerified: true, role: "user" });
    ctx.links.set("google|g-new", "old");
    const code = await ctx.mint(1);
    const { res } = await oauth(ctx, `?invite=${encodeURIComponent(code)}`);
    expect(res!.statusCode).toBe(302);
    expect(ctx.invites.redemptions).toHaveLength(0);
  });
});

describe("AI-agent signup in invite mode", () => {
  const digest = (s: string) => new Uint8Array(createHash("sha256").update(s, "utf8").digest());
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  function agentApp() {
    const invites = memoryInviteStore();
    const store = fakeStore();
    const app = Fastify();
    registerAgentRoutes(app, { store: store as never, issueApiKey: async () => "eck_test", launchMode: "invite", inviteStore: invites.store });
    return { app, invites };
  }
  async function agentSignup(app: ReturnType<typeof Fastify>, key: { secretKey: Uint8Array; publicKey: Uint8Array }, extra: Record<string, unknown> = {}) {
    const k = { keyType: "ed25519", publicKey: hex(key.publicKey) };
    const c = (await app.inject({ method: "POST", url: "/agents/challenge", payload: k })).json();
    return app.inject({ method: "POST", url: "/agents/signup", payload: { ...k, nonce: c.nonce, signature: hex(ed25519.sign(digest(c.challenge), key.secretKey)), ...extra } });
  }

  it("a new key needs a code; the same key signs up again (key rotation) without one", async () => {
    const { app, invites } = agentApp();
    const key = ed25519.keygen();
    expect((await agentSignup(app, key)).json().error).toBe("invite_required");
    const code = generateInviteCode();
    await invites.store.createInviteCode({ codeId: "c".repeat(24), codeHash: inviteCodeHash(code), prefix: code.slice(0, 7), label: null, maxUses: 1, expiresAtMs: null, createdBy: "a", createdAtMs: 1 });
    const first = await agentSignup(app, key, { inviteCode: code });
    expect(first.statusCode).toBe(200);
    expect(first.json().created).toBe(true);
    const again = await agentSignup(app, key);
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);
  });
});

describe("sign-up page", () => {
  it("asks for an invite code only in invite mode", async () => {
    const { registerHomePage } = await import("../../src/portal/pages/home.js");
    const app = Fastify();
    registerHomePage(app);
    const prev = process.env.LAUNCH_MODE;
    try {
      process.env.LAUNCH_MODE = "invite";
      expect((await app.inject({ url: "/portal" })).body).toContain('id="signupInvite"');
      process.env.LAUNCH_MODE = "open";
      expect((await app.inject({ url: "/portal" })).body).not.toContain('id="signupInvite"');
    } finally {
      if (prev === undefined) delete process.env.LAUNCH_MODE;
      else process.env.LAUNCH_MODE = prev;
    }
  });
});
