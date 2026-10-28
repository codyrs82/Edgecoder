import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSessionExpired, isSessionExpired, isSessionExpiry, markSessionExpired, onSessionExpired } from "../src/lib/session-state";

afterEach(() => clearSessionExpired());

describe("session expiry state (#24)", () => {
  it("only a 401 on a token-bearing, non-auth request counts", () => {
    expect(isSessionExpiry(401, "/portal/api/conversations", true)).toBe(true);
    expect(isSessionExpiry(401, "/portal/api/conversations", false)).toBe(false);
    expect(isSessionExpiry(403, "/portal/api/conversations", true)).toBe(false);
    expect(isSessionExpiry(401, "/me", true)).toBe(false);
    expect(isSessionExpiry(401, "/auth/login", true)).toBe(false);
    expect(isSessionExpiry(401, "/auth/oauth/mobile/complete", true)).toBe(false);
  });

  it("notifies once until cleared, and late subscribers see the current state", () => {
    const a = vi.fn();
    const off = onSessionExpired(a);
    markSessionExpired();
    markSessionExpired();
    expect(a).toHaveBeenCalledTimes(1);
    expect(isSessionExpired()).toBe(true);
    const late = vi.fn();
    onSessionExpired(late);
    expect(late).toHaveBeenCalledTimes(1);
    off();
    clearSessionExpired();
    markSessionExpired();
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("a throwing listener doesn't stop the others", () => {
    const ok = vi.fn();
    onSessionExpired(() => { throw new Error("x"); });
    onSessionExpired(ok);
    markSessionExpired();
    expect(ok).toHaveBeenCalled();
  });
});
