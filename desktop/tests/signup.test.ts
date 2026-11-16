import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMe, loadSessionToken, signup, signupNeedsInvite, SignupError } from "../src/lib/api";

// Desktop sign-up signs in, as sign-in does: the portal's session token is kept and sent as Bearer.
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const user = { userId: "u1", email: "cody@proton.me", displayName: null, emailVerified: false };

describe("desktop sign-up", () => {
  beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it("posts to /auth/signup, keeps the session token and uses it from then on", async () => {
    const fetchMock = vi.fn(async (url: string) => (String(url).endsWith("/auth/signup") ? reply(200, { ok: true, sessionToken: "tok-1", user }) : reply(200, { user })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await signup({ email: "cody@proton.me", password: "correct-horse-1", inviteCode: " EC-1 ", acceptTerms: true })).toEqual(user);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/auth\/signup$/);
    expect(JSON.parse(String(init.body))).toEqual({ email: "cody@proton.me", password: "correct-horse-1", acceptTerms: true, inviteCode: "EC-1" });
    expect(loadSessionToken()).toBe("tok-1");
    await getMe();
    const meInit = fetchMock.mock.calls[1][1] as unknown as RequestInit;
    expect((meInit.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
  });

  it("an app already signed in to that account goes straight in (no new token)", async () => {
    localStorage.setItem("edgecoder_session_token", "tok-old");
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { ok: true, alreadySignedIn: true, userId: "u1", user })));
    expect(await signup({ email: "cody@proton.me", password: "correct-horse-1", acceptTerms: true })).toEqual(user);
    expect(loadSessionToken()).toBe("tok-old");
  });

  it("an existing account is a SignupError with its code, and nothing is saved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(409, { error: "email_already_registered" })));
    const err = await signup({ email: "cody@proton.me", password: "correct-horse-1", acceptTerms: true }).catch((e) => e);
    expect(err).toBeInstanceOf(SignupError);
    expect(err.code).toBe("email_already_registered");
    expect(err.message).toBe("An account with this email already exists.");
    expect(loadSessionToken()).toBeNull();
  });

  it("reads whether an invite code is needed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { launch: { mode: "invite", inviteRequired: true } })));
    expect(await signupNeedsInvite()).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await signupNeedsInvite()).toBe(false);
  });
});
