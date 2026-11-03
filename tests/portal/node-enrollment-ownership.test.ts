import pg from "pg";
import { describe, expect, it } from "vitest";
import { PortalStore } from "../../src/portal/store.js";

const PG_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!PG_URL)("node enrollment ownership against real Postgres", () => {
  it("lets the owner rotate a node's token but never hands the node to another user", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    try {
      const store = new PortalStore(pool);
      await store.migrate();
      const nodeId = `own-test-${Date.now()}`;
      const base = { nodeId, nodeKind: "agent" as const, emailVerified: true };
      const first = await store.upsertNodeEnrollment({ ...base, ownerUserId: "u-owner", ownerEmail: "o@example.com", registrationTokenHash: "h1" });
      expect(first?.ownerUserId).toBe("u-owner");
      const rotated = await store.upsertNodeEnrollment({ ...base, ownerUserId: "u-owner", ownerEmail: "o@example.com", registrationTokenHash: "h2" });
      expect(rotated?.ownerUserId).toBe("u-owner");
      expect(await store.upsertNodeEnrollment({ ...base, ownerUserId: "u-attacker", ownerEmail: "a@example.com", registrationTokenHash: "h3" })).toBeNull();
      const after = await store.getNodeEnrollment(nodeId);
      expect(after?.ownerUserId).toBe("u-owner");
      await store.deleteNodeEnrollment(nodeId);
    } finally {
      await pool.end();
    }
  });
  it("does not redirect another user's node ID through the caller's own device ID", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    try {
      const store = new PortalStore(pool);
      await store.migrate();
      const t = Date.now();
      const victim = `victim-${t}`;
      const mine = `mine-${t}`;
      const base = { nodeKind: "agent" as const, emailVerified: true };
      await store.upsertNodeEnrollment({ ...base, nodeId: victim, deviceId: `vdev-${t}`, ownerUserId: "u-victim", ownerEmail: "v@example.com", registrationTokenHash: "h1" });
      await store.upsertNodeEnrollment({ ...base, nodeId: mine, deviceId: `adev-${t}`, ownerUserId: "u-attacker", ownerEmail: "a@example.com", registrationTokenHash: "h2" });
      expect(await store.upsertNodeEnrollment({ ...base, nodeId: victim, deviceId: `adev-${t}`, ownerUserId: "u-attacker", ownerEmail: "a@example.com", registrationTokenHash: "h3" })).toBeNull();
      expect(await store.upsertNodeEnrollment({ ...base, nodeId: `new-${t}`, deviceId: `vdev-${t}`, ownerUserId: "u-attacker", ownerEmail: "a@example.com", registrationTokenHash: "h4" })).toBeNull();
      expect((await store.getNodeEnrollment(victim))?.ownerUserId).toBe("u-victim");
      // The caller's own device still redirects to its canonical node.
      const own = await store.upsertNodeEnrollment({ ...base, nodeId: `new-${t}`, deviceId: `adev-${t}`, ownerUserId: "u-attacker", ownerEmail: "a@example.com", registrationTokenHash: "h5" });
      expect(own?.nodeId).toBe(mine);
      await store.deleteNodeEnrollment(victim);
      await store.deleteNodeEnrollment(mine);
    } finally {
      await pool.end();
    }
  });
});
