import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseCookies, readCookie } from "../../src/portal/portal-utils.js";
import { appChallengeFor, appVerifierMatches, nativeRedirectMatches } from "../../src/portal/native-app-auth.js";

vi.mock("undici", () => ({
  request: vi.fn(async () => ({ statusCode: 500, body: { json: async () => ({}), text: async () => "", dump: async () => {} } }))
}));
const { registerAuthRoutes } = await import("../../src/portal/routes/auth.js");

const verifier = () => randomBytes(32).toString("base64url");

describe("native app OAuth binding helpers", () => {
  it("accepts a matching verifier, and neither for older apps", () => {
    const v = verifier();
    expect(appVerifierMatches(appChallengeFor(v), v)).toBe(true);
    expect(appVerifierMatches(undefined, undefined)).toBe(true);
  });
  it("refuses a wrong or missing verifier, and a verifier for an unbound token", () => {
    const v = verifier();
    expect(appVerifierMatches(appChallengeFor(v), verifier())).toBe(false);
    expect(appVerifierMatches(appChallengeFor(v), undefined)).toBe(false);
    expect(appVerifierMatches(undefined, v)).toBe(false);
  });
  it("matches the configured callback exactly (scheme, host, path)", () => {
    const cfg = "edgecoder://oauth-callback";
    expect(nativeRedirectMatches("edgecoder://oauth-callback", cfg)).toBe(true);
    expect(nativeRedirectMatches("edgecoder://oauth-callback/", cfg)).toBe(true);
    expect(nativeRedirectMatches("edgecoder://oauth-callback?x=1", cfg)).toBe(true);
    expect(nativeRedirectMatches("edgecoder://oauth-callback.evil", cfg)).toBe(false);
    expect(nativeRedirectMatches("edgecoder://oauth-callbackx/y", cfg)).toBe(false);
    expect(nativeRedirectMatches("edgecoder://oauth-callback/other", cfg)).toBe(false);
    expect(nativeRedirectMatches("edgecoder://user:pw@oauth-callback", cfg)).toBe(false);
    expect(nativeRedirectMatches("https://oauth-callback", cfg)).toBe(false);
    expect(nativeRedirectMatches("other://oauth-callback", cfg)).toBe(false);
  });
});

describe("/auth/oauth/mobile/complete binds the token to the app's verifier", () => {
  function build() {
    const tokens = new Map<string, { userId: string; appChallenge?: string }>();
    const states: any[] = [];
    const app = Fastify();
    registerAuthRoutes(app, {
      store: {
        getUserById: async (id: string) => ({ userId: id, email: "v@x.io", emailVerified: true, role: "user" }),
        createOauthState: async (s: unknown) => { states.push(s); },
        consumeOauthState: async () => null
      },
      oauthProviders: { google: { clientId: "c", clientSecret: "s", scopes: "openid", authorizeUrl: "https://idp.example/auth", tokenUrl: "https://idp.example/token" } },
      PORTAL_PUBLIC_URL: "https://portal.example",
      OAUTH_MICROSOFT_PROMPT: "",
      normalizeNativeOauthRedirect: (v?: string) => (v === "edgecoder://oauth-callback" ? v : null),
      consumeMobileOauthSessionToken: async (t: string) => {
        const r = tokens.get(t) ?? null;
        tokens.delete(t);
        return r;
      },
      createSessionForUser: async () => "session-token",
      parseCookies,
      readCookie
    } as any);
    return { app, tokens, states };
  }
  const complete = (app: ReturnType<typeof Fastify>, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/auth/oauth/mobile/complete", payload });
  const token = () => randomBytes(24).toString("hex");

  it("answers CORS for the desktop app's origin on every OS, and no other origin", async () => {
    const { app } = build();
    // macOS/Linux WebKit, Windows WebView2 (default http, https with useHttpsScheme).
    for (const origin of ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]) {
      const pre = await app.inject({ method: "OPTIONS", url: "/auth/oauth/mobile/complete", headers: { origin } });
      expect(pre.statusCode).toBe(204);
      expect(pre.headers["access-control-allow-origin"]).toBe(origin);
      const res = await app.inject({ method: "POST", url: "/auth/oauth/mobile/complete", headers: { origin }, payload: { token: token() } });
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
    }
    const evil = await app.inject({ method: "OPTIONS", url: "/auth/oauth/mobile/complete", headers: { origin: "https://evil.example" } });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("redeems a bound token with its verifier", async () => {
    const { app, tokens } = build();
    const v = verifier();
    const t = token();
    tokens.set(t, { userId: "victim", appChallenge: appChallengeFor(v) });
    const res = await complete(app, { token: t, verifier: v });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, sessionToken: "session-token", user: { userId: "victim" } });
  });

  it("refuses a bound token without or with the wrong verifier", async () => {
    const { app, tokens } = build();
    const v = verifier();
    const a = token();
    const b = token();
    tokens.set(a, { userId: "u", appChallenge: appChallengeFor(v) });
    tokens.set(b, { userId: "u", appChallenge: appChallengeFor(v) });
    expect((await complete(app, { token: a })).statusCode).toBe(400);
    expect((await complete(app, { token: b, verifier: verifier() })).statusCode).toBe(400);
  });

  it("refuses an unbound token (another sign-in's) when the app sends a verifier; older apps still work", async () => {
    const { app, tokens } = build();
    const a = token();
    const b = token();
    tokens.set(a, { userId: "attacker" });
    tokens.set(b, { userId: "legacy" });
    expect((await complete(app, { token: a, verifier: verifier() })).statusCode).toBe(400);
    expect((await complete(app, { token: b })).statusCode).toBe(200);
  });

  it("/start stores appChallenge with a native redirect only, and rejects a malformed one", async () => {
    const { app, states } = build();
    const c = appChallengeFor(verifier());
    const r1 = await app.inject({ url: `/auth/oauth/google/start?appRedirect=${encodeURIComponent("edgecoder://oauth-callback")}&appChallenge=${c}` });
    expect(r1.statusCode).toBe(302);
    expect(states[0]).toMatchObject({ nativeRedirect: "edgecoder://oauth-callback", appChallenge: c });
    await app.inject({ url: `/auth/oauth/google/start?appChallenge=${c}` });
    expect(states[1].appChallenge).toBeUndefined();
    const bad = await app.inject({ url: `/auth/oauth/google/start?appRedirect=edgecoder://oauth-callback&appChallenge=short` });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
  });
});
