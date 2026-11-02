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
});
