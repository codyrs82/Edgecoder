import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResultVerifier, type PendingVerificationSnapshot } from "../../src/swarm/verification.js";
import type { Subtask } from "../../src/common/types.js";
import { PG_URL, twoCoordinatorsOneDatabase, type SharedDb } from "../helpers/shared-pg.js";

// #105/#162: verification reputation (per reward account) and held verifications in Postgres,
// with two coordinators (the US and EU seeds) on one database.

const subtask = (id: string): Subtask => ({
  id,
  taskId: "t",
  kind: "single_step",
  language: "python",
  input: "x",
  timeoutMs: 60_000,
  snapshotRef: "commit:test",
  projectMeta: { projectId: "p", resourceClass: "cpu", priority: 10 }
});

describe.skipIf(!PG_URL)("result verification state shared by two coordinators", () => {
  let db: SharedDb;
  beforeAll(async () => {
    db = await twoCoordinatorsOneDatabase();
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });

  it("reputation deltas from both coordinators all apply, clamped to [0, 1]", async () => {
    expect(await db.a.getVerificationReputation("acct-x")).toBeUndefined();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? db.a : db.b).adjustVerificationReputation("acct-x", -0.01, 0.5))
    );
    expect(await db.b.getVerificationReputation("acct-x")).toBeCloseTo(0.3, 6);
    expect(await db.a.adjustVerificationReputation("acct-x", -5, 0.5)).toBe(0);
    expect(await db.b.adjustVerificationReputation("acct-new", 5, 0.5)).toBe(1);
  });

  it("a held verification survives a restart of the coordinator that holds it, and only that one", async () => {
    let now = 1_000;
    const cfg = { rate: 1, timeoutMs: 60_000, replicaClaimTimeoutMs: 10_000 };
    const writes: Promise<unknown>[] = [];
    const before = new ResultVerifier<{ note: string }>(cfg, () => 0, () => now);
    before.onChange((c) => {
      if (c.kind === "pending") writes.push(db.a.upsertPendingVerification("coord-a", c.originalSubtaskId, c.snapshot, c.snapshot.startedAtMs));
      else if (c.kind === "settled") writes.push(db.a.deletePendingVerification("coord-a", c.originalSubtaskId));
      else writes.push(db.a.adjustVerificationReputation(c.key, c.delta, 0.5));
    });
    before.start(subtask("held-1"), { subtaskId: "held-1", agentId: "a1", accountId: "acct-a", ok: true, output: "42", meta: { note: "kept" } });
    await Promise.all(writes);

    // The other seed neither sees it as its own nor can overwrite it.
    expect(await db.b.listPendingVerifications("coord-b")).toEqual([]);
    expect(await db.b.upsertPendingVerification("coord-b", "held-1", { hijack: true }, 0)).toBe(false);
    expect(await db.b.deletePendingVerification("coord-b", "held-1")).toBe(false);

    // Restart: a fresh verifier on coordinator A restores it and re-issues a replica.
    now = 5_000;
    const after = new ResultVerifier<{ note: string }>(cfg, () => 0, () => now);
    const [snap] = await db.a.listPendingVerifications<PendingVerificationSnapshot<{ note: string }>>("coord-a");
    const next = after.restore(snap);
    expect(next?.excludeAccounts).toEqual(["acct-a"]);
    const verdict = after.recordReplica(next!.subtask.id, { subtaskId: next!.subtask.id, agentId: "b1", accountId: "acct-b", ok: true, output: "42", meta: { note: "replica" } });
    expect(verdict).toMatchObject({ status: "verified", output: "42", winners: [{ meta: { note: "kept" } }, { meta: { note: "replica" } }] });
    await db.a.deletePendingVerification("coord-a", "held-1");
    expect(await db.a.listPendingVerifications("coord-a")).toEqual([]);
  });
});
