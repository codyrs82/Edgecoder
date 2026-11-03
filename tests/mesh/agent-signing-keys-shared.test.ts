import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL, twoCoordinatorsOneDatabase, type SharedDb } from "../helpers/shared-pg.js";
import type { BlacklistRecord } from "../../src/common/types.js";

// #122: an agent key or blacklist entry written by one seed is visible to the other, which is what
// the origin of a forwarded result relies on to check the agent's own signature.

describe.skipIf(!PG_URL)("agent signing keys and blacklist on one Postgres shared by two coordinators", () => {
  let db: SharedDb;
  beforeAll(async () => {
    db = await twoCoordinatorsOneDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  it("a key registered on one seed is listed on the other, rotations keep old keys", async () => {
    await db.a.recordAgentSigningKey("agent-1", "PEM-OLD", "coord-us", 1_000);
    await db.a.recordAgentSigningKey("agent-1", "PEM-OLD", "coord-us", 2_000);
    await db.a.recordAgentSigningKey("agent-1", "PEM-NEW", "coord-us", 3_000);
    expect(await db.b.listAgentSigningKeys("agent-1")).toEqual(["PEM-NEW", "PEM-OLD"]);
    expect(await db.b.listAgentSigningKeys("agent-unknown")).toEqual([]);
  });

  it("the latest blacklist event for an agent is visible to the other seed", async () => {
    const rec = (eventId: string, timestampMs: number, reason: string): BlacklistRecord => ({
      eventId, agentId: "agent-bad", reasonCode: "manual", reason, evidenceHashSha256: "h", reporterId: "r",
      evidenceSignatureVerified: false, sourceCoordinatorId: "coord-us", reportedBy: "ops", timestampMs,
      prevEventHash: "p", eventHash: `e-${eventId}`, coordinatorSignature: "s"
    } as BlacklistRecord);
    expect(await db.b.latestBlacklistEvent("agent-bad")).toBeNull();
    await db.a.persistBlacklistEvent(rec("ev-1", 1_000, "first"));
    await db.a.persistBlacklistEvent(rec("ev-2", 2_000, "second"));
    expect(await db.b.latestBlacklistEvent("agent-bad")).toMatchObject({ eventId: "ev-2", reason: "second" });
    expect((await db.b.listBlacklistEvents()).map((e) => e.eventId)).toEqual(["ev-1", "ev-2"]);
  });
});
