import { describe, expect, it } from "vitest";
import { SwarmQueue } from "../../src/swarm/queue.js";
import {
  ResultVerifier,
  resultKey,
  verificationConfigFromEnv,
  DEFAULT_VERIFICATION,
  type ExecutionResult,
  type ReplicaRequest
} from "../../src/swarm/verification.js";
import type { Subtask } from "../../src/common/types.js";

// #50: redundant execution; mismatches earn nothing and lower reputation.
const policy = { allowIdleOnly: false, maxCpuPercent: 100, maxMemoryMb: 4096 } as any;

function subtask(id: string, input: string): Subtask {
  return {
    id,
    taskId: "t",
    kind: "single_step",
    language: "python",
    input,
    timeoutMs: 60_000,
    snapshotRef: "commit:test",
    projectMeta: { projectId: "p", resourceClass: "cpu", priority: 10 }
  };
}

type Worker = (st: Subtask) => { ok: boolean; output: string };
const honest: Worker = (st) => ({ ok: true, output: `result(${st.input})` });
const malicious: Worker = () => ({ ok: true, output: "fake output, collect credits" });

/** Mini coordinator mirroring /result: sampled results held, replicas to other agents, credits only when verified/unsampled. */
function harness(rate: number, workers: Record<string, Worker>, random = () => 0) {
  const queue = new SwarmQueue(null, { graceMs: 1_000, livenessMs: 60_000, maxAttempts: 3 });
  const verifier = new ResultVerifier<{ id: string }>({ rate }, random);
  const credits = new Map<string, number>();
  const released: Array<{ id: string; output: string }> = [];
  const earn = (r: ExecutionResult<{ id: string }>) => credits.set(r.agentId, (credits.get(r.agentId) ?? 0) + 5);
  const enqueue = (req: ReplicaRequest) => queue.enqueueSubtask(req.subtask, { excludeAgents: req.excludeAgents });
  for (const id of Object.keys(workers)) queue.registerAgent(id, policy);

  function post(agentId: string, st: Subtask) {
    const out = workers[agentId](st);
    queue.complete({ subtaskId: st.id, taskId: st.taskId, agentId, ok: out.ok, output: out.output, durationMs: 10 });
    const exec: ExecutionResult<{ id: string }> = { subtaskId: st.id, agentId, ...out, meta: { id: st.id } };
    if (verifier.isReplica(st.id)) {
      const r = verifier.recordReplica(st.id, exec);
      if (r?.status === "pending") enqueue(r.next);
      else if (r) {
        r.winners.forEach(earn);
        if (r.status !== "unresolved") released.push({ id: r.originalSubtaskId, output: r.output });
      }
    } else if (verifier.shouldVerify(agentId)) {
      enqueue(verifier.start(st, exec));
    } else {
      earn(exec);
      released.push({ id: st.id, output: out.output });
    }
  }

  function run(order: string[]) {
    for (let round = 0; round < 200; round += 1) {
      let any = false;
      for (const a of order) {
        const st = queue.claim(a);
        if (st) { any = true; post(a, st); }
      }
      if (!any) break;
    }
  }
  return { queue, verifier, credits, released, run };
}

describe("ResultVerifier (#50)", () => {
  it("rate 0 never samples; rate 1 always; lower reputation samples more", () => {
    expect(new ResultVerifier({ rate: 0 }).shouldVerify("a")).toBe(false);
    expect(new ResultVerifier({ rate: 1 }, () => 0.999).shouldVerify("a")).toBe(true);
    const v = new ResultVerifier<null>({ rate: 0.1, mismatchPenalty: 0.5 }, () => 0);
    expect(v.sampleRate("a")).toBeCloseTo(0.1);
    const r1 = v.start(subtask("s", "x"), { subtaskId: "s", agentId: "a", ok: true, output: "bad", meta: null });
    const r2 = v.recordReplica(r1.subtask.id, { subtaskId: r1.subtask.id, agentId: "b", ok: true, output: "good", meta: null });
    expect(r2?.status).toBe("pending");
    if (r2?.status !== "pending") throw new Error("expected pending");
    const r3 = v.recordReplica(r2.next.subtask.id, { subtaskId: r2.next.subtask.id, agentId: "c", ok: true, output: "good", meta: null });
    expect(r3).toMatchObject({ status: "verified", output: "good" });
    expect(v.reputation("a")).toBe(0.5);
    expect(v.sampleRate("a")).toBeCloseTo(0.15);
  });

  it("output comparison normalizes line endings and whitespace, and includes ok", () => {
    expect(resultKey({ ok: true, output: "a\r\nb\n" })).toBe(resultKey({ ok: true, output: "  a\nb" }));
    expect(resultKey({ ok: true, output: "a" })).not.toBe(resultKey({ ok: false, output: "a" }));
  });

  it("replicas exclude every agent that already executed", () => {
    const v = new ResultVerifier<null>({ rate: 1 }, () => 0);
    const r1 = v.start(subtask("s", "x"), { subtaskId: "s", agentId: "a", ok: true, output: "1", meta: null });
    expect(r1.excludeAgents).toEqual(["a"]);
    expect(r1.subtask.id).toBe("s::verify:1");
    const r2 = v.recordReplica(r1.subtask.id, { subtaskId: r1.subtask.id, agentId: "b", ok: true, output: "2", meta: null });
    expect(r2).toMatchObject({ status: "pending", next: { excludeAgents: ["a", "b"] } });
  });

  it("no majority after maxExecutions: unresolved, nobody earns", () => {
    const v = new ResultVerifier<null>({ rate: 1, maxExecutions: 2 }, () => 0);
    const r1 = v.start(subtask("s", "x"), { subtaskId: "s", agentId: "a", ok: true, output: "1", meta: null });
    const r2 = v.recordReplica(r1.subtask.id, { subtaskId: r1.subtask.id, agentId: "b", ok: true, output: "2", meta: null });
    expect(r2).toMatchObject({ status: "unresolved", winners: [] });
  });

  it("the same agent can't vote twice", () => {
    const v = new ResultVerifier<null>({ rate: 1 }, () => 0);
    const r1 = v.start(subtask("s", "x"), { subtaskId: "s", agentId: "a", ok: true, output: "1", meta: null });
    expect(v.recordReplica(r1.subtask.id, { subtaskId: r1.subtask.id, agentId: "a", ok: true, output: "1", meta: null })).toBeNull();
  });

  it("timeout releases an unreplicated result unverified", () => {
    let now = 0;
    const v = new ResultVerifier<null>({ rate: 1, timeoutMs: 1000 }, () => 0, () => now);
    v.start(subtask("s", "x"), { subtaskId: "s", agentId: "a", ok: true, output: "1", meta: null });
    expect(v.expire()).toEqual([]);
    now = 1001;
    expect(v.expire()).toMatchObject([{ status: "timeout", originalSubtaskId: "s", output: "1" }]);
    expect(v.isPending("s")).toBe(false);
  });

  it("config from env with bounds", () => {
    expect(verificationConfigFromEnv({})).toEqual(DEFAULT_VERIFICATION);
    expect(verificationConfigFromEnv({ RESULT_VERIFICATION_RATE: "0.5" }).rate).toBe(0.5);
    expect(verificationConfigFromEnv({ RESULT_VERIFICATION_RATE: "2" }).rate).toBe(DEFAULT_VERIFICATION.rate);
    expect(verificationConfigFromEnv({ RESULT_VERIFICATION_MAX_EXECUTIONS: "1" }).maxExecutions).toBe(3);
  });

  it("verification is off by default (rate 0): nothing is sampled", () => {
    expect(DEFAULT_VERIFICATION.rate).toBe(0);
    expect(verificationConfigFromEnv({}).rate).toBe(0);
    const v = new ResultVerifier<null>(verificationConfigFromEnv({}), () => 0);
    expect(v.sampleRate("anyone")).toBe(0);
    expect(v.shouldVerify("anyone")).toBe(false);
  });

  it("replicas exclude the original's reward account; a second agent id on it can't vote", () => {
    const v = new ResultVerifier<null>({ rate: 1 }, () => 0);
    const r1 = v.start(subtask("s", "x"), { subtaskId: "s", agentId: "a1", accountId: "acct", ok: true, output: "1", meta: null });
    expect(r1.excludeAccounts).toEqual(["acct"]);
    expect(
      v.recordReplica(r1.subtask.id, { subtaskId: r1.subtask.id, agentId: "a2", accountId: "acct", ok: true, output: "1", meta: null })
    ).toBeNull();
    expect(v.isPending("s")).toBe(true);
  });

  it("queue: an agent on an excluded reward account can't claim the replica", () => {
    const q = new SwarmQueue(null);
    q.registerAgent("a2", policy);
    q.registerAgent("b", policy);
    q.enqueueSubtask(subtask("r", "x"), { excludeAgents: ["a1"], excludeAccounts: ["acct"] });
    expect(q.claim("a2", undefined, "acct")).toBeUndefined();
    expect(q.claim("b", undefined, "other")?.id).toBe("r");
  });

  it("queue: removeHeld takes the item off without publishing a result", () => {
    const q = new SwarmQueue(null);
    q.registerAgent("a", policy);
    q.enqueueSubtask(subtask("h", "x"));
    q.claim("a");
    expect(q.removeHeld("h")).toBe(true);
    expect(q.status().results).toBe(0);
    expect(q.getClaim("h")).toBeUndefined();
  });

  it("queue: an excluded agent can't claim the replica", () => {
    const q = new SwarmQueue(null);
    q.registerAgent("a", policy);
    q.registerAgent("b", policy);
    q.enqueueSubtask(subtask("r", "x"), { excludeAgents: ["a"] });
    expect(q.claim("a")).toBeUndefined();
    expect(q.claim("b")?.id).toBe("r");
  });
});

describe("malicious fake worker (#50)", () => {
  it("rate 1: the cheater earns nothing, honest agents earn, the verified output is the honest one", () => {
    const h = harness(1, { evil: malicious, h1: honest, h2: honest });
    h.queue.enqueueSubtask(subtask("s1", "1+1"));
    h.run(["evil", "h1", "h2"]);
    expect(h.credits.get("evil") ?? 0).toBe(0);
    expect(h.credits.get("h1")).toBe(5);
    expect(h.credits.get("h2")).toBe(5);
    expect(h.released).toEqual([{ id: "s1", output: "result(1+1)" }]);
    expect(h.verifier.reputation("evil")).toBeLessThan(1);
    expect(h.verifier.reputation("h1")).toBe(1);
  });

  it("honest original confirmed by an honest replica: both earn", () => {
    const h = harness(1, { h1: honest, h2: honest, evil: malicious });
    h.queue.enqueueSubtask(subtask("s1", "2"));
    h.run(["h1", "h2", "evil"]);
    expect(h.credits.get("h1")).toBe(5);
    expect(h.credits.get("h2")).toBe(5);
    expect(h.credits.get("evil") ?? 0).toBe(0);
    expect(h.released).toEqual([{ id: "s1", output: "result(2)" }]);
  });

  it("over many tasks the cheater's reputation hits 0 and it is always sampled", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    const h = harness(0.5, { evil: malicious, h1: honest, h2: honest }, rnd);
    for (let i = 0; i < 30; i += 1) h.queue.enqueueSubtask(subtask(`s${i}`, String(i)));
    h.run(["evil", "h1", "h2"]);
    expect(h.verifier.reputation("evil")).toBe(0);
    expect(h.verifier.sampleRate("evil")).toBe(1);
    expect(h.verifier.reputation("h1")).toBe(1);
  });

  it("limitation: a colluding majority with identical fake output wins (k-of-n can't beat that)", () => {
    const h = harness(1, { evil1: malicious, evil2: malicious, h1: honest });
    h.queue.enqueueSubtask(subtask("s1", "x"));
    h.run(["evil1", "evil2", "h1"]);
    expect(h.credits.get("h1") ?? 0).toBe(0);
  });
});
