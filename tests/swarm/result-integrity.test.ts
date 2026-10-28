import { describe, expect, test } from "vitest";
import { SwarmQueue } from "../../src/swarm/queue.js";
import { PostgresStore } from "../../src/db/postgres.js";
import { accrueCredits, creditEngine } from "../../src/credits/store.js";
import {
  checkResultClaim,
  classifyResultAuth,
  creditedDurationMs,
  requireSignedAgentRequests,
  resultReportId
} from "../../src/swarm/result-integrity.js";

const policy = {
  cpuCapPercent: 50,
  memoryLimitMb: 1024,
  idleOnly: false,
  maxConcurrentTasks: 1,
  allowedHours: { startHourUtc: 0, endHourUtc: 24 }
};

function queueWithClaim(timeoutMs = 4000) {
  const queue = new SwarmQueue();
  queue.registerAgent("agent-a", policy as any);
  queue.registerAgent("agent-b", policy as any);
  const st = queue.enqueueSubtask({
    taskId: "task-1",
    kind: "single_step",
    language: "python",
    input: "print(1)",
    timeoutMs,
    snapshotRef: "snap",
    projectMeta: { projectId: "p", resourceClass: "cpu", priority: 1 }
  } as any);
  const claimed = queue.claim("agent-a");
  expect(claimed?.id).toBe(st.id);
  return { queue, subtaskId: st.id };
}

describe("/result integrity (#44)", () => {
  test("unsigned /result -> rejected (401) when signatures are required", () => {
    expect(
      classifyResultAuth({ verified: null, hasLocalClaim: true, meshTokenConfigured: true, meshTokenValid: false, requireSigned: true })
    ).toBe("reject");
    // empty MESH_AUTH_TOKEN never enables the peer path
    expect(
      classifyResultAuth({ verified: null, hasLocalClaim: false, meshTokenConfigured: false, meshTokenValid: true, requireSigned: true })
    ).toBe("reject");
    expect(
      classifyResultAuth({ verified: "rejected", hasLocalClaim: true, meshTokenConfigured: true, meshTokenValid: true, requireSigned: false })
    ).toBe("reject");
    expect(
      classifyResultAuth({ verified: { agentId: "a" }, hasLocalClaim: true, meshTokenConfigured: false, meshTokenValid: false, requireSigned: true })
    ).toBe("agent");
  });

  test("mesh-token peer forward only for subtasks without a local claim", () => {
    expect(
      classifyResultAuth({ verified: null, hasLocalClaim: false, meshTokenConfigured: true, meshTokenValid: true, requireSigned: true })
    ).toBe("peer_forward");
    expect(
      classifyResultAuth({ verified: null, hasLocalClaim: true, meshTokenConfigured: true, meshTokenValid: true, requireSigned: true })
    ).toBe("reject");
  });

  test("REQUIRE_SIGNED_AGENT_REQUESTS defaults true and is forced in production", () => {
    expect(requireSignedAgentRequests({})).toBe(true);
    expect(requireSignedAgentRequests({ REQUIRE_SIGNED_AGENT_REQUESTS: "false" })).toBe(false);
    expect(requireSignedAgentRequests({ NODE_ENV: "production", REQUIRE_SIGNED_AGENT_REQUESTS: "false" })).toBe(true);
  });

  test("signed by agent B for a subtask claimed by A -> 403, A's claim intact", () => {
    const { queue, subtaskId } = queueWithClaim();
    const check = checkResultClaim(queue.getClaim(subtaskId), "agent-b");
    expect(check).toEqual({ ok: false, code: 403, error: "not_claimant" });
    expect(queue.getClaim(subtaskId)?.claimedBy).toBe("agent-a");
    expect(checkResultClaim(queue.getClaim(subtaskId), "agent-a")).toEqual({ ok: true });
  });

  test("unclaimed or already completed subtask -> 409", () => {
    const { queue, subtaskId } = queueWithClaim();
    queue.complete({ subtaskId, taskId: "task-1", agentId: "agent-a", ok: true, output: "", durationMs: 1 } as any);
    expect(queue.getClaim(subtaskId)).toBeUndefined();
    expect(checkResultClaim(queue.getClaim(subtaskId), "agent-a")).toMatchObject({ code: 409 });
  });

  test("durationMs 10_000_000 with timeoutMs 4000 -> credited duration <= 4000", () => {
    const now = Date.now();
    const claim = { subtask: { id: "s", timeoutMs: 4000 }, claimedBy: "agent-a", claimedAt: now - 60_000 };
    expect(creditedDurationMs(10_000_000, claim, now)).toBe(4000);
    // measured since claim also caps it
    expect(creditedDurationMs(10_000_000, { ...claim, claimedAt: now - 1500 }, now)).toBe(1500);
    expect(creditedDurationMs(-5, claim, now)).toBe(0);
  });

  test("same result posted twice -> one credit transaction", async () => {
    const report = {
      reportId: resultReportId("subtask-dup-1"),
      agentId: "acct-dup",
      sourceAgentId: "agent-a",
      taskId: "task-1",
      resourceClass: "cpu" as const,
      cpuSeconds: 4,
      gpuSeconds: 0,
      success: true,
      qualityScore: 1,
      timestampMs: Date.now()
    };
    const load = { queuedTasks: 0, activeAgents: 1 };
    const first = await accrueCredits(report, load);
    const second = await accrueCredits({ ...report, timestampMs: Date.now() + 1 }, load);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(creditEngine.history("acct-dup")).toHaveLength(1);
  });

  test("queued but UNCLAIMED local copy + valid mesh token -> peer_forward (relayed result accepted)", () => {
    const queue = new SwarmQueue();
    const st = queue.enqueueSubtask({
      taskId: "task-2",
      kind: "single_step",
      language: "python",
      input: "x",
      timeoutMs: 1000,
      snapshotRef: "snap",
      projectMeta: { projectId: "p", resourceClass: "cpu", priority: 1 }
    } as any);
    const claim = queue.getClaim(st.id);
    expect(claim).toBeDefined();
    expect(
      classifyResultAuth({
        verified: null,
        hasLocalClaim: Boolean(claim?.claimedBy),
        meshTokenConfigured: true,
        meshTokenValid: true,
        requireSigned: true
      })
    ).toBe("peer_forward");
  });

  describe("persistContributionWithCredit (PG, one transaction)", () => {
    function fakeStore(reportRowCount: number, failCreditInsert = false) {
      const calls: string[] = [];
      const client = {
        async query(sql: string) {
          const first = sql.trim().split(/\s+/).slice(0, 3).join(" ");
          calls.push(first);
          if (sql.includes("INSERT INTO compute_contribution_reports")) return { rowCount: reportRowCount, rows: [] };
          if (sql.includes("INSERT INTO credit_transactions") && failCreditInsert) throw new Error("boom");
          return { rowCount: 1, rows: [] };
        },
        release() {
          calls.push("release");
        }
      };
      const store = new PostgresStore({ connect: async () => client } as any);
      return { store, calls };
    }
    const input = {
      report: {
        reportId: "result:s1", agentId: "a", taskId: "t", resourceClass: "cpu" as const,
        cpuSeconds: 1, gpuSeconds: 0, success: true, qualityScore: 1, timestampMs: 1
      },
      accountId: "a", sourceAgentId: "a", reliabilityScore: 1, weightedContribution: 1
    };
    const tx = { txId: "tx1", accountId: "a", type: "earn" as const, credits: 1, reason: "compute_contribution", timestampMs: 1 };

    test("new report: BEGIN, report insert, credit insert, COMMIT", async () => {
      const { store, calls } = fakeStore(1);
      expect(await store.persistContributionWithCredit(input as any, tx as any)).toBe(true);
      expect(calls).toEqual(["BEGIN", "INSERT INTO compute_contribution_reports", "INSERT INTO credit_transactions", "COMMIT", "release"]);
    });

    test("duplicate report: ROLLBACK, no credit insert", async () => {
      const { store, calls } = fakeStore(0);
      expect(await store.persistContributionWithCredit(input as any, tx as any)).toBe(false);
      expect(calls).not.toContain("INSERT INTO credit_transactions");
      expect(calls).toContain("ROLLBACK");
    });

    test("credit insert fails: ROLLBACK (report row not kept), error surfaces", async () => {
      const { store, calls } = fakeStore(1, true);
      await expect(store.persistContributionWithCredit(input as any, tx as any)).rejects.toThrow("boom");
      expect(calls).toContain("ROLLBACK");
      expect(calls).not.toContain("COMMIT");
    });
  });
});
