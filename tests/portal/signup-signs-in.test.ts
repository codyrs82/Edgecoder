import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Create account signs you in (the real portal server, with an in-memory store): the same session
 * row and cookie as POST /auth/login, behind the same CSRF origin check and auth rate limit. The
 * account stays unverified, with every unverified-account gate in place, until the emailed link
 * is confirmed.
 */

vi.mock("undici", async (importOriginal) => {
  const mod = await importOriginal<typeof import("undici")>();
  return {
    ...mod,
    request: async () => {
      throw new Error("network disabled in tests");
    }
  };
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

type User = { userId: string; email: string; emailVerified: boolean; passwordHash?: string; displayName?: string; role: "user"; uiTheme: string; createdAtMs: number };
const users = new Map<string, User>();
const sessions = new Map<string, { sessionId: string; userId: string; expiresAtMs: number }>();
const created: Array<{ userId: string; tokenHash: string; expiresAtMs: number }> = [];
const enrollments: Array<Record<string, unknown>> = [];

const overrides: Record<string, (...args: never[]) => unknown> = {
  getUserByEmail: (email: string) => [...users.values()].find((u) => u.email === email) ?? null,
  getUserById: (userId: string) => users.get(userId) ?? null,
  createUser: (u: Omit<User, "role" | "uiTheme" | "createdAtMs">) => {
    const user: User = { ...u, role: "user", uiTheme: "warm", createdAtMs: Date.now() };
    users.set(u.userId, user);
    return user;
  },
  createSession: (s: { sessionId: string; userId: string; tokenHash: string; expiresAtMs: number }) => {
    created.push(s);
    sessions.set(s.tokenHash, s);
  },
  getSessionByTokenHash: (hash: string) => {
    const s = sessions.get(hash);
    return s && s.expiresAtMs > Date.now() ? s : null;
  },
  upsertNodeEnrollment: (r: Record<string, unknown>) => {
    enrollments.push(r);
    return { ...r, nodeApproved: false, active: false };
  }
};
const store = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop !== "string" || prop === "then" || prop === "pool") return undefined;
      return async (...args: never[]) => {
        if (overrides[prop]) return overrides[prop](...args);
        if (/^(list|search|recent)/.test(prop)) return [];
        if (/^(count|sum)/.test(prop)) return 0;
        return null;
      };
    }
  }
);

let app: FastifyInstance;
let ip = 0;
const freshIp = () => `10.77.${(ip >> 8) & 255}.${ip++ & 255}`;
const json = { "content-type": "application/json" };

const signup = (email: string, headers: Record<string, string> = {}, remoteAddress = freshIp()) =>
  app.inject({ method: "POST", url: "/auth/signup", remoteAddress, headers: { ...json, ...headers }, payload: { email, password: "correct-horse-1", acceptTerms: true } });

const sessionCookie = (res: { headers: Record<string, unknown> }) =>
  ([] as string[]).concat((res.headers["set-cookie"] as string | string[] | undefined) ?? []).find((c) => c.startsWith("edgecoder_portal_session="));
const tokenOf = (cookie: string) => cookie.split(";")[0].split("=")[1];
const attrs = (cookie: string) => cookie.split(";").slice(1).map((p) => p.trim().replace(/^Max-Age=\d+$/i, "Max-Age")).sort();

beforeAll(async () => {
  for (const name of ["PORTAL_DATABASE_URL", "DATABASE_URL", "PORTAL_ORIGIN_LOCK_TOKEN", "PORTAL_EDGE", "PORTAL_PUBLIC_URL", "PORTAL_TRUSTED_ORIGINS", "RESEND_API_KEY", "LAUNCH_MODE"]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("LOG_LEVEL", "silent");
  vi.stubGlobal("fetch", async () => {
    throw new Error("network disabled in tests");
  });
  const { PortalStore } = await import("../../src/portal/store.js");
  vi.spyOn(PortalStore, "fromEnv").mockReturnValue(store as never);
  ({ portalServer: app } = await import("../../src/portal/server.js"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /auth/signup signs in", () => {
  it("creates a session and sets the same cookie as /auth/login; /me then answers for the new, unverified account", async () => {
    const res = await signup("first@example.test");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, emailVerification: "sent", user: { email: "first@example.test", emailVerified: false } });
    const cookie = sessionCookie(res)!;
    expect(cookie).toBeDefined();
    // The session row is the one login writes: keyed by the token's hash, never the token.
    const row = created.find((s) => s.userId === body.userId)!;
    expect(row.tokenHash).toBe(sha256(tokenOf(cookie)));
    expect(body.sessionToken).toBe(tokenOf(cookie));

    // Same cookie flags as password sign-in.
    const login = await app.inject({ method: "POST", url: "/auth/login", remoteAddress: freshIp(), headers: json, payload: { email: "first@example.test", password: "correct-horse-1" } });
    expect(login.statusCode).toBe(200);
    expect(attrs(cookie)).toEqual(attrs(sessionCookie(login)!));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax|SameSite=Strict/i);

    const me = await app.inject({ url: "/me", headers: { cookie: cookie.split(";")[0] } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ email: "first@example.test", emailVerified: false });
  });

  it("a second click from the browser that just created the account goes straight in", async () => {
    const first = await signup("twice@example.test");
    const cookie = sessionCookie(first)!.split(";")[0];
    const sessionsBefore = created.length;
    const again = await signup("twice@example.test", { cookie });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ ok: true, alreadySignedIn: true, userId: first.json().userId });
    // No new session, and no token handed out.
    expect(created.length).toBe(sessionsBefore);
    expect(again.json().sessionToken).toBeUndefined();
  });

  it("anyone else gets email_already_registered and no session", async () => {
    await signup("taken@example.test");
    const sessionsBefore = created.length;
    const other = await signup("taken@example.test");
    expect(other.statusCode).toBe(409);
    expect(other.json().error).toBe("email_already_registered");
    expect(sessionCookie(other)).toBeUndefined();
    expect(created.length).toBe(sessionsBefore);
    // A session for a different account does not count either.
    const mine = sessionCookie(await signup("mine@example.test"))!.split(";")[0];
    expect((await signup("taken@example.test", { cookie: mine })).statusCode).toBe(409);
  });

  it("keeps the CSRF origin check", async () => {
    const res = await signup("csrf@example.test", { origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("cross_site_request_forbidden");
    expect([...users.values()].some((u) => u.email === "csrf@example.test")).toBe(false);
  });

  it("keeps the auth rate limit (10 a minute per client IP)", async () => {
    const addr = "10.99.0.1";
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await signup(`rl-${i}@example.test`, {}, addr)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe("an unverified account signed in by sign-up keeps the unverified gates", () => {
  let cookie: string;
  beforeAll(async () => {
    cookie = sessionCookie(await signup("gated@example.test"))!.split(";")[0];
  });

  it("cannot create an API key", async () => {
    const res = await app.inject({ method: "POST", url: "/portal/api/keys", remoteAddress: freshIp(), headers: { ...json, cookie }, payload: { name: "ci" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("email_not_verified");
  });

  it("cannot register a passkey", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/passkey/register/options", remoteAddress: freshIp(), headers: { ...json, cookie }, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("email_not_verified");
  });

  it("a node it enrolls is recorded as unverified (inactive until the address is verified)", async () => {
    const res = await app.inject({ method: "POST", url: "/nodes/enroll", remoteAddress: freshIp(), headers: { ...json, cookie }, payload: { nodeId: "gated-node-1", nodeKind: "agent" } });
    expect(res.statusCode).toBe(200);
    expect(enrollments.at(-1)).toMatchObject({ nodeId: "gated-node-1", emailVerified: false });
    expect(res.json()).toMatchObject({ emailVerified: false, nodeApproved: false, active: false });
  });
});
