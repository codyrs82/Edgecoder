import { describe, expect, it } from "vitest";
import { PortalStore } from "../../src/portal/store.js";
import { AUTH_RATE_LIMIT, rateLimitFor } from "../../src/portal/security.js";

// Short-lived sign-in rows (OAuth states, sessions, passkey challenges, email verifications) are
// written by unauthenticated or cheap requests; expired ones are deleted as new ones are written.

function recordingStore() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      return { rows: [], rowCount: 0 };
    }
  };
  return { store: new PortalStore(pool as never), queries };
}

const deletes = (queries: Array<{ sql: string }>, table: string) => queries.filter((q) => q.sql.startsWith(`DELETE FROM ${table} WHERE expires_at_ms <`));

describe("expired sign-in rows are pruned on write", () => {
  it("OAuth states", async () => {
    const { store, queries } = recordingStore();
    await store.createOauthState({ stateId: "s", provider: "google", redirectUri: "https://x/cb", expiresAtMs: Date.now() + 600_000 });
    expect(deletes(queries, "portal_oauth_states")).toHaveLength(1);
  });

  it("sessions", async () => {
    const { store, queries } = recordingStore();
    await store.createSession({ sessionId: "s", userId: "u", tokenHash: "h", expiresAtMs: Date.now() + 1000 });
    const [del] = deletes(queries, "portal_sessions");
    expect(del).toBeDefined();
    expect(Number((del as { params: unknown[] }).params[0])).toBeLessThanOrEqual(Date.now());
  });

  it("passkey challenges", async () => {
    const { store, queries } = recordingStore();
    await store.createPasskeyChallenge({ challengeId: "c", challenge: "x", flowType: "authentication", expiresAtMs: Date.now() + 1000 });
    expect(deletes(queries, "portal_passkey_challenges")).toHaveLength(1);
  });

  it("email verifications, kept a day past expiry for the resend count", async () => {
    const { store, queries } = recordingStore();
    await store.createEmailVerification({ tokenId: "t", userId: "u", tokenHash: "h", expiresAtMs: Date.now() + 1000 });
    const [del] = deletes(queries, "portal_email_verifications");
    expect(Number(del.params[0])).toBeLessThanOrEqual(Date.now() - 24 * 60 * 60 * 1000);
  });
});

describe("OAuth start", () => {
  it("is in the per-IP auth rate-limit bucket", () => {
    expect(rateLimitFor("/auth/oauth/:provider/start", "GET")).toEqual(AUTH_RATE_LIMIT);
    expect(rateLimitFor("/auth/oauth/:provider/callback", "GET")).toEqual(AUTH_RATE_LIMIT);
  });
});
