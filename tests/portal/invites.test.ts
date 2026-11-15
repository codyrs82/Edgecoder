import Fastify from "fastify";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { generateInviteCode, inviteCodeHash, inviteCodeUsable, normalizeInviteCode, redeemInviteForNewAccount, registerInviteAdminRoutes } from "../../src/portal/invites.js";
import { PortalStore } from "../../src/portal/store.js";
import { memoryInviteStore } from "./invite-store-memory.js";

describe("invite codes", () => {
  it("are EC- plus 16 unambiguous characters, and typed forms normalise to the same code", () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^EC-[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
    expect(normalizeInviteCode(code.toLowerCase().replace(/-/g, " "))).toBe(code);
    expect(normalizeInviteCode(` ${code} `)).toBe(code);
    expect(normalizeInviteCode("EC-ABCD")).toBeNull();
    expect(normalizeInviteCode(42)).toBeNull();
    expect(inviteCodeHash(code)).not.toContain(code);
  });

  it("open mode needs no code; invite mode takes one use of a live code", async () => {
    const { store } = memoryInviteStore();
    expect(await redeemInviteForNewAccount({ mode: "open", store, code: undefined, userId: "u" })).toEqual({ ok: true, redeemed: false });
    expect(await redeemInviteForNewAccount({ mode: "invite", store, code: undefined, userId: "u" })).toMatchObject({ ok: false, error: "invite_required" });
    expect(await redeemInviteForNewAccount({ mode: "invite", store, code: "nonsense", userId: "u" })).toMatchObject({ ok: false, error: "invite_invalid" });
    const code = generateInviteCode();
    await store.createInviteCode({ codeId: "a".repeat(24), codeHash: inviteCodeHash(code), prefix: code.slice(0, 7), label: null, maxUses: 2, expiresAtMs: null, createdBy: "admin@x", createdAtMs: 1 });
    expect(await inviteCodeUsable(store, code.toLowerCase())).toBe(code);
    expect(await redeemInviteForNewAccount({ mode: "invite", store, code, userId: "u1" })).toEqual({ ok: true, redeemed: true });
    expect(await redeemInviteForNewAccount({ mode: "invite", store, code, userId: "u2" })).toEqual({ ok: true, redeemed: true });
    expect(await redeemInviteForNewAccount({ mode: "invite", store, code, userId: "u3" })).toMatchObject({ ok: false, error: "invite_invalid" });
    expect(await inviteCodeUsable(store, code)).toBeNull();
  });
});

function adminApp(isAdmin: boolean) {
  const mem = memoryInviteStore();
  const app = Fastify();
  let now = 1_000_000;
  registerInviteAdminRoutes(app, {
    store: mem.store,
    launchMode: "invite",
    getCurrentUser: async (req) => (req.headers.cookie ? { userId: "admin-1", email: "admin@edgecoder.io" } : null),
    buildAccessContext: async () => ({ isSystemAdmin: isAdmin }),
    now: () => now
  });
  return { app, mem, advance: (ms: number) => (now += ms) };
}

describe("Settings > Admin > Early access API", () => {
  const auth = { cookie: "edgecoder_portal_session=s" };

  it("is for system admins only", async () => {
    const { app } = adminApp(false);
    expect((await app.inject({ method: "GET", url: "/portal/api/admin/invites" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/portal/api/admin/invites", headers: auth })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/portal/api/admin/invites", headers: auth, payload: { maxUses: 1 } })).statusCode).toBe(403);
  });

  it("mints a code shown once, lists it without the code, expires it and revokes it", async () => {
    const { app, mem, advance } = adminApp(true);
    const minted = await app.inject({ method: "POST", url: "/portal/api/admin/invites", headers: auth, payload: { label: "Friends of Bob", maxUses: 3, expiresInDays: 7 } });
    expect(minted.statusCode).toBe(200);
    const { code, invite } = minted.json();
    expect(normalizeInviteCode(code)).toBe(code);
    expect(invite).toMatchObject({ prefix: code.slice(0, 7), label: "Friends of Bob", maxUses: 3, uses: 0, status: "active", createdBy: "admin@edgecoder.io", expiresAtMs: 1_000_000 + 7 * 86_400_000 });

    const listed = await app.inject({ method: "GET", url: "/portal/api/admin/invites", headers: auth });
    expect(listed.json().launchMode).toBe("invite");
    expect(JSON.stringify(listed.json())).not.toContain(code);
    expect(listed.json().invites[0].codeId).toBe(invite.codeId);

    await mem.store.redeemInviteCode(inviteCodeHash(code), "u1", 1_000_001);
    expect((await app.inject({ method: "GET", url: "/portal/api/admin/invites", headers: auth })).json().invites[0]).toMatchObject({ uses: 1, status: "active" });
    advance(8 * 86_400_000);
    expect((await app.inject({ method: "GET", url: "/portal/api/admin/invites", headers: auth })).json().invites[0].status).toBe("expired");

    const revoke = await app.inject({ method: "POST", url: `/portal/api/admin/invites/${invite.codeId}/revoke`, headers: auth });
    expect(revoke.json()).toEqual({ ok: true });
    expect((await app.inject({ method: "GET", url: "/portal/api/admin/invites", headers: auth })).json().invites[0].status).toBe("revoked");
    expect((await app.inject({ method: "POST", url: `/portal/api/admin/invites/${invite.codeId}/revoke`, headers: auth })).statusCode).toBe(404);
  });

  it("refuses bad input", async () => {
    const { app } = adminApp(true);
    for (const payload of [{ maxUses: 0 }, { maxUses: 1001 }, { maxUses: 1, expiresInDays: 0 }, { label: "<script>" }]) {
      expect((await app.inject({ method: "POST", url: "/portal/api/admin/invites", headers: auth, payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: "/portal/api/admin/invites/not-an-id/revoke", headers: auth })).statusCode).toBe(400);
  });
});

const PG_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("invite codes against real Postgres", () => {
  it("redeem takes uses atomically and stops at max, expiry and revocation", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 4 });
    try {
      const store = new PortalStore(pool);
      await store.migrate();
      const t = Date.now();
      const code = generateInviteCode();
      const codeId = `${t}`.padStart(24, "0").slice(-24).replace(/[^0-9a-f]/g, "0");
      await store.createInviteCode({ codeId, codeHash: inviteCodeHash(code), prefix: code.slice(0, 7), label: "pg", maxUses: 2, expiresAtMs: t + 60_000, createdBy: "t", createdAtMs: t });
      const results = await Promise.all([1, 2, 3, 4].map((i) => store.redeemInviteCode(inviteCodeHash(code), `u${i}-${t}`, t)));
      expect(results.filter(Boolean)).toHaveLength(2);
      expect(await store.inviteCodeRedeemable(inviteCodeHash(code), t)).toBe(false);
      expect((await store.listInviteCodes(500)).find((c) => c.codeId === codeId)).toMatchObject({ uses: 2, maxUses: 2 });
      expect(await store.revokeInviteCode(codeId, t)).toBe(true);
      await pool.query(`DELETE FROM portal_invite_redemptions WHERE code_id = $1`, [codeId]);
      await pool.query(`DELETE FROM portal_invite_codes WHERE code_id = $1`, [codeId]);
    } finally {
      await pool.end();
    }
  });
});
