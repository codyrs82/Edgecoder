import pg from "pg";
import { describe, expect, it } from "vitest";
import { PortalStore } from "../../src/portal/store.js";

const PG_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!PG_URL)("passkey credential ownership against real Postgres", () => {
  it("updates the owner's own credential but never re-assigns it to another user", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    try {
      const store = new PortalStore(pool);
      await store.migrate();
      const credentialId = `cred-${Date.now()}`;
      const base = { credentialId, webauthnUserId: "w", counter: 0, deviceType: "singleDevice", backedUp: false };
      expect(await store.upsertPasskeyCredential({ ...base, userId: "u-owner", publicKeyB64Url: "owner-key" })).toBe(true);
      expect(await store.upsertPasskeyCredential({ ...base, userId: "u-owner", publicKeyB64Url: "owner-key-2" })).toBe(true);
      expect(await store.upsertPasskeyCredential({ ...base, userId: "u-attacker", publicKeyB64Url: "attacker-key" })).toBe(false);
      const row = await store.findPasskeyByCredentialId(credentialId);
      expect(row?.userId).toBe("u-owner");
      expect(row?.publicKeyB64Url).toBe("owner-key-2");
      await pool.query(`DELETE FROM portal_passkey_credentials WHERE credential_id = $1`, [credentialId]);
    } finally {
      await pool.end();
    }
  });
});
