import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCookies, readCookie } from "../../src/portal/portal-utils.js";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_APPLE,
  oauthStateClearCookie,
  oauthStateCookieMatches,
  oauthStateKey,
  oauthStateSecretProblem,
  assertOauthStateSecret,
  oauthStateSetCookie
} from "../../src/portal/oauth-state-cookie.js";

// Token exchange is stubbed to fail with 500, so "proceeds" = got past the state checks (502).
vi.mock("undici", () => ({
  request: vi.fn(async () => ({ statusCode: 500, body: { json: async () => ({}), text: async () => "", dump: async () => {} } }))
}));
const { registerAuthRoutes } = await import("../../src/portal/routes/auth.js");

const PROVIDERS = ["google", "microsoft", "github"] as const;

function build() {
  const states = new Map<string, { stateId: string; provider: string; redirectUri: string }>();
  const store = {
    createOauthState: vi.fn(async (s: { stateId: string; provider: string; redirectUri: string }) => {
      states.set(s.stateId, s);
    }),
    consumeOauthState: vi.fn(async (id: string) => {
      const s = states.get(id);
      states.delete(id);
      return s ?? null;
    })
  };
  const cfg = { clientId: "cid", clientSecret: "secret", scopes: "openid", authorizeUrl: "https://idp.example/auth", tokenUrl: "https://idp.example/token" };
  const app = Fastify();
  registerAuthRoutes(app, {
    store,
    oauthProviders: { google: cfg, microsoft: cfg, github: cfg },
    PORTAL_PUBLIC_URL: "https://portal.example",
    OAUTH_MICROSOFT_PROMPT: "",
    oauthNativeRedirectByState: new Map(),
    normalizeNativeOauthRedirect: () => null,
    parseCookies,
    readCookie
  } as any);
  return { app, store };
}

async function start(app: ReturnType<typeof build>["app"], provider: string) {
  const res = await app.inject({ url: `/auth/oauth/${provider}/start` });
  expect(res.statusCode).toBe(302);
  const state = new URL(String(res.headers.location)).searchParams.get("state")!;
  const setCookie = ([] as string[]).concat(res.headers["set-cookie"] as string | string[]);
  const cookie = setCookie.find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`))!;
  return { state, cookie, pair: cookie.split(";")[0] };
}

describe("OAuth state bound to the browser (#88)", () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build();
  });

  for (const provider of PROVIDERS) {
    describe(provider, () => {
      it("/start sets a __Host- cookie: Secure, HttpOnly, Path=/, SameSite=Lax, 10 min", async () => {
        const { cookie } = await start(ctx.app, provider);
        expect(cookie).toMatch(/^__Host-oauth_state=/);
        expect(cookie).toContain("Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600");
        expect(cookie).not.toContain("Domain=");
      });

      it("valid cookie + state proceeds past the state check", async () => {
        const { state, pair } = await start(ctx.app, provider);
        const res = await ctx.app.inject({ url: `/auth/oauth/${provider}/callback?code=c&state=${state}`, headers: { cookie: pair } });
        expect(res.statusCode).toBe(502); // token exchange stub
        expect(String(res.headers["set-cookie"])).toContain(`${OAUTH_STATE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
      });

      it("missing cookie -> 403, and the state is burned", async () => {
        const { state, pair } = await start(ctx.app, provider);
        const res = await ctx.app.inject({ url: `/auth/oauth/${provider}/callback?code=c&state=${state}` });
        expect(res.statusCode).toBe(403);
        const again = await ctx.app.inject({ url: `/auth/oauth/${provider}/callback?code=c&state=${state}`, headers: { cookie: pair } });
        expect(again.statusCode).toBe(403);
      });

      it("cookie from another flow (mismatched state) -> 403", async () => {
        const a = await start(ctx.app, provider);
        const b = await start(ctx.app, provider);
        const res = await ctx.app.inject({ url: `/auth/oauth/${provider}/callback?code=c&state=${a.state}`, headers: { cookie: b.pair } });
        expect(res.statusCode).toBe(403);
      });

      it("replayed state -> 403", async () => {
        const { state, pair } = await start(ctx.app, provider);
        await ctx.app.inject({ url: `/auth/oauth/${provider}/callback?code=c&state=${state}`, headers: { cookie: pair } });
        const replay = await ctx.app.inject({ url: `/auth/oauth/${provider}/callback?code=c&state=${state}`, headers: { cookie: pair } });
        expect(replay.statusCode).toBe(403);
      });

      it("unprefixed cookie is not accepted", async () => {
        const { state, pair } = await start(ctx.app, provider);
        const res = await ctx.app.inject({ url: `/auth/oauth/${provider}/callback?code=c&state=${state}`, headers: { cookie: pair.replace("__Host-", "") } });
        expect(res.statusCode).toBe(403);
      });
    });
  }

  it("a cookie issued for one provider doesn't work for another", async () => {
    const g = await start(ctx.app, "google");
    const res = await ctx.app.inject({ url: `/auth/oauth/github/callback?code=c&state=${g.state}`, headers: { cookie: g.pair } });
    expect(res.statusCode).toBe(403);
  });

  it("POST callback is checked the same way", async () => {
    const { state } = await start(ctx.app, "google");
    const res = await ctx.app.inject({ method: "POST", url: "/auth/oauth/google/callback", payload: { code: "c", state } });
    expect(res.statusCode).toBe(403);
  });

  it("Apple stays disabled (404) until it is wired", async () => {
    expect((await ctx.app.inject({ method: "POST", url: "/auth/oauth/apple/callback", payload: {} })).statusCode).toBe(404);
  });
});

describe("state cookie primitives (#88)", () => {
  const key = oauthStateKey({ OAUTH_STATE_SECRET: "k".repeat(32) });

  it("Apple's form_post uses its own SameSite=None cookie", () => {
    expect(oauthStateSetCookie(key, "apple", "s1")).toMatch(new RegExp(`^${OAUTH_STATE_COOKIE_APPLE}=apple\\.s1\\..+; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=600$`));
    expect(oauthStateClearCookie("apple")).toContain("SameSite=None; Max-Age=0");
  });

  it("rejects a tampered MAC or a different key", () => {
    const v = oauthStateSetCookie(key, "google", "s1").split(";")[0].split("=")[1];
    expect(oauthStateCookieMatches(key, v, "google", "s1")).toBe(true);
    expect(oauthStateCookieMatches(key, v.slice(0, -2) + "xx", "google", "s1")).toBe(false);
    expect(oauthStateCookieMatches(oauthStateKey({ OAUTH_STATE_SECRET: "other".repeat(8) }), v, "google", "s1")).toBe(false);
    expect(oauthStateCookieMatches(key, undefined, "google", "s1")).toBe(false);
  });

  it("the same OAUTH_STATE_SECRET verifies across instances", () => {
    const a = oauthStateKey({ OAUTH_STATE_SECRET: "shared".repeat(6) });
    const b = oauthStateKey({ OAUTH_STATE_SECRET: "shared".repeat(6) });
    const v = oauthStateSetCookie(a, "github", "s9").split(";")[0].split("=")[1];
    expect(oauthStateCookieMatches(b, v, "github", "s9")).toBe(true);
  });
});

describe("OAUTH_STATE_SECRET startup check (#88)", () => {
  it("is required in production", () => {
    expect(oauthStateSecretProblem({ NODE_ENV: "production" })).toMatch(/required/);
    expect(oauthStateSecretProblem({ NODE_ENV: "production", OAUTH_STATE_SECRET: "   " })).toMatch(/required/);
  });
  it("must be at least 32 characters in production", () => {
    expect(oauthStateSecretProblem({ NODE_ENV: "production", OAUTH_STATE_SECRET: "k".repeat(31) })).toMatch(/32/);
    expect(oauthStateSecretProblem({ NODE_ENV: "production", OAUTH_STATE_SECRET: "k".repeat(32) })).toBeNull();
  });
  it("assertOauthStateSecret throws the problem", () => {
    expect(() => assertOauthStateSecret({ NODE_ENV: "production" })).toThrow(/OAUTH_STATE_SECRET is required/);
    expect(() => assertOauthStateSecret({ NODE_ENV: "production", OAUTH_STATE_SECRET: "k".repeat(40) })).not.toThrow();
  });
  it("is optional outside production", () => {
    expect(oauthStateSecretProblem({})).toBeNull();
    expect(oauthStateSecretProblem({ NODE_ENV: "test" })).toBeNull();
  });
});
