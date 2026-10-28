import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { SwarmQueue } from "../../src/swarm/queue.js";
import { lateResultRejection } from "../../src/swarm/lease-gate.js";
import { SubtaskDepTracker } from "../../src/swarm/subtask-deps.js";
import type { Subtask, SubtaskResult } from "../../src/common/types.js";

// #51 review: route-level check that a late result gets 409 and earns nothing,
// using the same gate and ordering as the coordinator's /result route.
const policy = { allowIdleOnly: false, maxCpuPercent: 100, maxMemoryMb: 4096 } as any;
const LEASE = { graceMs: 10_000, livenessMs: 20_000, maxAttempts: 3 };

function subtask(timeoutMs = 60_000): Omit<Subtask, "id"> {
  return {
    taskId: "task-1",
    kind: "micro_loop",
    language: "python",
    input: "print(1)",
    timeoutMs,
    snapshotRef: "commit:test",
    projectMeta: { projectId: "p", resourceClass: "cpu", priority: 10 }
  };
}

function buildApp(queue: SwarmQueue) {
  const credited: string[] = [];
  const app = Fastify();
  app.post("/result", async (req, reply) => {
    const body = req.body as SubtaskResult;
    const late = lateResultRejection(queue, body.subtaskId, body.agentId);
    if (late) return reply.code(late.statusCode).send(late.body);
    const claim = queue.getClaim(body.subtaskId);
    if (!claim || claim.claimedBy !== body.agentId) return reply.code(409).send({ error: "not_claimant" });
    queue.complete(body);
    credited.push(body.agentId);
    return reply.send({ ok: true });
  });
  return { app, credited };
}

const result = (subtaskId: string, agentId: string): SubtaskResult => ({
  subtaskId, taskId: "task-1", agentId, ok: true, output: "1", durationMs: 10
});

describe("/result late-result gate (#51)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => vi.useRealTimers());

  it("returns 409 lease_expired to an expired holder and credits nothing", async () => {
    const q = new SwarmQueue(null, LEASE);
    q.registerAgent("A", policy);
    q.registerAgent("B", policy);
    const st = q.enqueueSubtask(subtask());
    expect(q.claim("A")?.id).toBe(st.id);
    vi.advanceTimersByTime(LEASE.livenessMs + 1); // A goes silent
    expect(q.claim("B")?.id).toBe(st.id);
    const { app, credited } = buildApp(q);

    const late = await app.inject({ method: "POST", url: "/result", payload: result(st.id, "A") });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toEqual({ error: "lease_expired" });
    expect(credited).toEqual([]);

    const ok = await app.inject({ method: "POST", url: "/result", payload: result(st.id, "B") });
    expect(ok.statusCode).toBe(200);
    expect(credited).toEqual(["B"]);
  });

  it("reports cap failures once to the listener and caps huge timeouts", () => {
    const q = new SwarmQueue(null, { ...LEASE, maxAttempts: 1, maxTimeoutMs: 30_000, livenessMs: 10 * 60_000 });
    const failures: SubtaskResult[] = [];
    q.onLeaseFailure((r) => failures.push(r));
    q.registerAgent("A", policy);
    const st = q.enqueueSubtask(subtask(24 * 60 * 60_000)); // 24h requested
    q.claim("A");
    vi.advanceTimersByTime(30_000 + LEASE.graceMs + 1); // capped deadline, despite liveness
    q.heartbeat("A");
    expect(q.getClaim(st.id)).toBeUndefined();
    expect(failures.map((f) => [f.subtaskId, f.agentId, f.ok])).toEqual([[st.id, "coordinator", false]]);
    q.expireLeases();
    expect(failures).toHaveLength(1);
  });

  it("dropDependents fails everything downstream of a failed subtask", () => {
    const deps = new SubtaskDepTracker();
    const mk = (id: string, dependsOn: string[]) => ({ subtask: { ...subtask(), id }, dependsOn });
    deps.hold(mk("b", ["a"]));
    deps.hold(mk("c", ["b"]));
    deps.hold(mk("d", ["x"]));
    expect(deps.dropDependents("a").map((s) => s.id).sort()).toEqual(["b", "c"]);
    expect([...deps.pending.keys()]).toEqual(["d"]);
  });
});
