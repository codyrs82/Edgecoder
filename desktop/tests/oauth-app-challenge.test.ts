import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPendingOAuth, completeOAuthWithToken, getOAuthStartUrl, oauthChallengeFor, pendingOAuthVerifier } from "../src/lib/api";

// Login CSRF guard: the deep-link token is only redeemed with the verifier of a flow this app started.
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

describe("OAuth app challenge", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("start URL carries sha256(verifier) as appChallenge and keeps the verifier pending", async () => {
    const url = new URL(await getOAuthStartUrl("google"));
    expect(url.pathname).toBe("/auth/oauth/google/start");
    expect(url.searchParams.get("appRedirect")).toBe("edgecoder://oauth-callback");
    const verifier = pendingOAuthVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expected = createHash("sha256").update(verifier!).digest("base64url");
    expect(url.searchParams.get("appChallenge")).toBe(expected);
    expect(await oauthChallengeFor(verifier!)).toBe(expected);
  });

  it("completes only with a pending verifier, sends it once, then clears it", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, user: { userId: "u" } }), { status: 200 });
    });
    await expect(completeOAuthWithToken("t".repeat(32))).rejects.toThrow(/No sign-in/);
    expect(calls).toHaveLength(0);
    await getOAuthStartUrl("github");
    const verifier = pendingOAuthVerifier();
    await completeOAuthWithToken("t".repeat(32));
    expect(calls[0].url).toMatch(/\/auth\/oauth\/mobile\/complete$/);
    expect(calls[0].body).toEqual({ token: "t".repeat(32), verifier });
    expect(pendingOAuthVerifier()).toBeNull();
    await expect(completeOAuthWithToken("t".repeat(32))).rejects.toThrow(/No sign-in/);
  });

  it("a pending flow expires after 10 minutes", async () => {
    await getOAuthStartUrl("microsoft");
    expect(pendingOAuthVerifier(Date.now() + 9 * 60_000)).not.toBeNull();
    expect(pendingOAuthVerifier(Date.now() + 11 * 60_000)).toBeNull();
    expect(pendingOAuthVerifier()).toBeNull();
    clearPendingOAuth();
  });
});
