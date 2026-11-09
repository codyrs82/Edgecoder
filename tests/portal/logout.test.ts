import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { parseCookies, readCookie, sha256Hex } from "../../src/portal/portal-utils.js";
import { registerAuthRoutes } from "../../src/portal/routes/auth.js";

// The desktop app presents its session as Authorization: Bearer (its webview is cross-site, so the
// cookie is not sent). Signing out must end that session on the server, not only the cookie one.
function build() {
  const sessions = new Set(["cookie-session", "bearer-session", "other-session"]);
  const app = Fastify();
  registerAuthRoutes(app, {
    store: {
      deleteSessionByTokenHash: async (hash: string) => {
        for (const t of sessions) if (sha256Hex(t) === hash) sessions.delete(t);
      }
    },
    oauthProviders: {},
    parseCookies,
    readCookie,
    sha256Hex,
    clearCookies: () => ["edgecoder_portal_session=; Max-Age=0"]
  } as any);
  return { app, sessions };
}

describe("POST /auth/logout", () => {
  it("revokes a Bearer session", async () => {
    const { app, sessions } = build();
    const res = await app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: "Bearer bearer-session" } });
    expect(res.statusCode).toBe(200);
    expect(sessions.has("bearer-session")).toBe(false);
    expect(sessions.has("other-session")).toBe(true);
  });

  it("revokes the cookie session, and both when both are sent", async () => {
    const { app, sessions } = build();
    await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: "edgecoder_portal_session=cookie-session", authorization: "Bearer bearer-session" } });
    expect([...sessions]).toEqual(["other-session"]);
  });

  it("succeeds with no session at all", async () => {
    const { app } = build();
    expect((await app.inject({ method: "POST", url: "/auth/logout" })).statusCode).toBe(200);
  });
});
