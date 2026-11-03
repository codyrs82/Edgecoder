import { describe, expect, it } from "vitest";
import { SwarmQueue } from "../../src/swarm/queue.js";
import {
  ResultVerifier,
  resultKey,
  verificationConfigFromEnv,
  payableWinners,
  verificationStartupWarning,
  DEFAULT_VERIFICATION,
  ReputationBook,
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
  const verifier = new ResultVerifier<{ id: string }>({ rate, initialReputation: 1 }, random);
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
    const v = new ResultVerifier<null>({ rate: 0.1, mismatchPenalty: 0.5, initialReputation: 1 }, () => 0);
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

describe("verification hardening (#106)", () => {
  it("unknown agents start at reputation 0.5 and are sampled more", () => {
    const v = new ResultVerifier<null>({ rate: 0.1 }, () => 0);
    expect(v.reputation("new-agent")).toBe(0.5);
    expect(v.sampleRate("new-agent")).toBeCloseTo(0.15);
  });

  it("a claimed-but-abandoned replica makes the result unresolved instead of paying it unverified", () => {
    let now = 0;
    const v = new ResultVerifier<null>({ rate: 1, timeoutMs: 1000 }, () => 0, () => now);
    const r1 = v.start(subtask("s", "x"), { subtaskId: "s", agentId: "a", ok: true, output: "1", meta: null });
    v.markReplicaClaimed(r1.subtask.id, "accomplice");
    now = 1001;
    expect(v.expire()).toMatchObject([{ status: "unresolved", winners: [], abandonedBy: ["accomplice"] }]);
  });

  it("a stalled replica claim is penalized and reassigned, excluding the abandoner", () => {
    let now = 0;
    const v = new ResultVerifier<null>({ rate: 1, timeoutMs: 60 * 60_000, replicaClaimTimeoutMs: 1000, abandonPenalty: 0.25 }, () => 0, () => now);
    const r1 = v.start(subtask("s", "x"), { subtaskId: "s", agentId: "a", ok: true, output: "1", meta: null });
    v.markReplicaClaimed(r1.subtask.id, "lazy");
    now = 1001;
    const { replacements, abandoned } = v.reassignStalled();
    expect(abandoned).toEqual([{ originalSubtaskId: "s", agentId: "lazy", accountId: "lazy" }]);
    expect(v.reputation("lazy")).toBeCloseTo(0.25);
    expect(replacements).toHaveLength(1);
    const next = replacements[0].request;
    expect(replacements[0].replaces).toBe(r1.subtask.id);
    expect(next.excludeAgents).toEqual(expect.arrayContaining(["a", "lazy"]));
    // The abandoner's late report on the old id is ignored; the new replica verifies.
    expect(v.recordReplica(r1.subtask.id, { subtaskId: r1.subtask.id, agentId: "lazy", ok: true, output: "1", meta: null })).toBeNull();
    expect(v.recordReplica(next.subtask.id, { subtaskId: next.subtask.id, agentId: "b", ok: true, output: "1", meta: null })).toMatchObject({ status: "verified" });
    // Penalized once only.
    expect(v.reputation("lazy")).toBeCloseTo(0.25);
  });

  it("maxReassignments controls how often a stalled replica is reissued (#114 review)", () => {
    let now = 0;
    const v = new ResultVerifier<null>({ rate: 1, timeoutMs: 60 * 60_000, replicaClaimTimeoutMs: 1000, maxReassignments: 2 }, () => 0, () => now);
    const r1 = v.start(subtask("s", "x"), { subtaskId: "s", agentId: "a", ok: true, output: "1", meta: null });
    v.markReplicaClaimed(r1.subtask.id, "lazy1");
    now = 1001;
    const first = v.reassignStalled().replacements;
    expect(first).toHaveLength(1);
    v.markReplicaClaimed(first[0].request.subtask.id, "lazy2");
    now = 2002;
    const second = v.reassignStalled().replacements;
    expect(second).toHaveLength(1);
    expect(second[0].request.excludeAgents).toEqual(expect.arrayContaining(["a", "lazy1", "lazy2"]));
    expect(second[0].request.subtask.id).not.toBe(first[0].request.subtask.id);
    v.markReplicaClaimed(second[0].request.subtask.id, "lazy3");
    now = 3003;
    const third = v.reassignStalled();
    expect(third.replacements).toHaveLength(0);
    expect(third.abandoned).toEqual([{ originalSubtaskId: "s", agentId: "lazy3", accountId: "lazy3" }]);

    const zero = new ResultVerifier<null>({ rate: 1, timeoutMs: 60 * 60_000, replicaClaimTimeoutMs: 1000, maxReassignments: 0 }, () => 0, () => now);
    const z1 = zero.start(subtask("z", "x"), { subtaskId: "z", agentId: "a", ok: true, output: "1", meta: null });
    zero.markReplicaClaimed(z1.subtask.id, "lazy");
    now += 1001;
    expect(zero.reassignStalled().replacements).toHaveLength(0);
    expect(verificationConfigFromEnv({ RESULT_VERIFICATION_MAX_REASSIGNMENTS: "3" }).maxReassignments).toBe(3);
  });

  it("an unclaimed replica still times out to an unverified accept (single-node meshes)", () => {
    let now = 0;
    const v = new ResultVerifier<null>({ rate: 1, timeoutMs: 1000 }, () => 0, () => now);
    v.start(subtask("s", "x"), { subtaskId: "s", agentId: "a", ok: true, output: "1", meta: null });
    now = 1001;
    expect(v.expire()).toMatchObject([{ status: "timeout", output: "1" }]);
  });

  it("maxExecutions is capped at 3", () => {
    expect(verificationConfigFromEnv({ RESULT_VERIFICATION_MAX_EXECUTIONS: "7" }).maxExecutions).toBe(3);
    const v = new ResultVerifier<null>({ rate: 1, maxExecutions: 7 }, () => 0);
    const r1 = v.start(subtask("s", "x"), { subtaskId: "s", agentId: "a", ok: true, output: "1", meta: null });
    const r2 = v.recordReplica(r1.subtask.id, { subtaskId: r1.subtask.id, agentId: "b", ok: true, output: "2", meta: null });
    if (r2?.status !== "pending") throw new Error("expected pending");
    const r3 = v.recordReplica(r2.next.subtask.id, { subtaskId: r2.next.subtask.id, agentId: "c", ok: true, output: "3", meta: null });
    expect(r3).toMatchObject({ status: "unresolved" });
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

// #114: replica rewards are minted only when explicitly enabled.
describe("replica reward minting (#114)", () => {
  const exec = (subtaskId: string) => ({ subtaskId, agentId: `a-${subtaskId}`, ok: true, output: "x" }) as unknown as ExecutionResult;
  const outcome = {
    status: "verified" as const,
    originalSubtaskId: "s1",
    winners: [exec("s1"), exec("s1#r1")],
    losers: [],
    output: "x",
    ok: true
  };

  it("defaults the mint flag to false", () => {
    expect(DEFAULT_VERIFICATION.mintReplicaRewards).toBe(false);
    expect(verificationConfigFromEnv({}).mintReplicaRewards).toBe(false);
    expect(verificationConfigFromEnv({ RESULT_VERIFICATION_MINT_REPLICA_REWARDS: "0" }).mintReplicaRewards).toBe(false);
    expect(verificationConfigFromEnv({ RESULT_VERIFICATION_MINT_REPLICA_REWARDS: "true" }).mintReplicaRewards).toBe(true);
  });

  it("pays only the original execution when the flag is false", () => {
    const paid = payableWinners(outcome, verificationConfigFromEnv({}));
    expect(paid.map((w) => w.subtaskId)).toEqual(["s1"]);
  });

  it("pays winning replicas when the flag is true", () => {
    const paid = payableWinners(outcome, { mintReplicaRewards: true });
    expect(paid.map((w) => w.subtaskId)).toEqual(["s1", "s1#r1"]);
  });

  it("warns at startup only when the verification rate is above 0", () => {
    expect(verificationStartupWarning({ rate: 0, mintReplicaRewards: false })).toBeNull();
    expect(verificationStartupWarning({ rate: 0.1, mintReplicaRewards: false })).toMatch(/NOT paid/);
    expect(verificationStartupWarning({ rate: 0.1, mintReplicaRewards: true })).toMatch(/minted/);
  });
});

const exec = (subtaskId: string, agentId: string, output: string, accountId?: string): ExecutionResult<null> => ({
  subtaskId, agentId, ...(accountId ? { accountId } : {}), ok: true, output, meta: null
});

// #162: abandonment and reputation follow the reward account, not the agent id.
describe("account-keyed reputation and abandonment (#162)", () => {
  it("a rotated agent id on the same account keeps the abandon penalty and stays excluded", () => {
    let now = 0;
    const v = new ResultVerifier<null>({ rate: 1, timeoutMs: 60 * 60_000, replicaClaimTimeoutMs: 1000, abandonPenalty: 0.25 }, () => 0, () => now);
    const r1 = v.start(subtask("s", "x"), exec("s", "a", "1", "acct-a"));
    v.markReplicaClaimed(r1.subtask.id, "lazy-1", "acct-lazy");
    now = 1001;
    const { replacements, abandoned } = v.reassignStalled();
    expect(abandoned).toEqual([{ originalSubtaskId: "s", agentId: "lazy-1", accountId: "acct-lazy" }]);
    expect(v.reputation("acct-lazy")).toBeCloseTo(0.25);
    expect(v.reputation("lazy-1")).toBe(0.5); // nothing keyed on the throwaway id
    expect(v.reputation("lazy-2")).toBe(0.5);
    const next = replacements[0].request;
    expect(next.excludeAccounts).toEqual(expect.arrayContaining(["acct-a", "acct-lazy"]));
    expect(next.excludeAgents).toEqual(expect.arrayContaining(["a", "lazy-1"]));
    // Same account under a new agent id abandons again: penalized once per subtask only.
    v.markReplicaClaimed(next.subtask.id, "lazy-2", "acct-lazy");
    now = 2002;
    v.reassignStalled();
    expect(v.reputation("acct-lazy")).toBeCloseTo(0.25);
  });

  it("sampling uses the account's reputation, so a fresh agent id on a caught account is still sampled more", () => {
    const v = new ResultVerifier<null>({ rate: 0.1, mismatchPenalty: 0.5, initialReputation: 1 }, () => 0);
    const r1 = v.start(subtask("s", "x"), exec("s", "evil-1", "bad", "acct-evil"));
    const r2 = v.recordReplica(r1.subtask.id, exec(r1.subtask.id, "h1", "good", "acct-h1"));
    if (r2?.status !== "pending") throw new Error("expected pending");
    v.recordReplica(r2.next.subtask.id, exec(r2.next.subtask.id, "h2", "good", "acct-h2"));
    expect(v.reputation("acct-evil")).toBe(0.5);
    expect(v.sampleRate("acct-evil")).toBeCloseTo(0.15);
  });

  it("disagreeing results with an abandoned tie-breaker: the abandoner is penalized too", () => {
    let now = 0;
    const v = new ResultVerifier<null>({ rate: 1, timeoutMs: 10_000, replicaClaimTimeoutMs: 1000, abandonPenalty: 0.25, mismatchPenalty: 0.2 }, () => 0, () => now);
    const r1 = v.start(subtask("s", "x"), exec("s", "a", "1", "acct-a"));
    const r2 = v.recordReplica(r1.subtask.id, exec(r1.subtask.id, "b", "2", "acct-b"));
    if (r2?.status !== "pending") throw new Error("expected pending");
    v.markReplicaClaimed(r2.next.subtask.id, "c", "acct-c");
    now = 10_001; // the tie-breaker never reports and the deadline passes before a reassignment tick
    const [out] = v.expire();
    expect(out).toMatchObject({ status: "unresolved", winners: [], abandonedBy: ["c"] });
    expect(v.reputation("acct-c")).toBeCloseTo(0.25);
    expect(v.reputation("acct-a")).toBeCloseTo(0.4);
  });
});

// #117: stalled replicas are reassigned until the overall deadline, not a fixed number of times.
describe("reassignment until the overall timeout (#117)", () => {
  it("keeps reassigning while more than one claim window remains, excluding every abandoner", () => {
    let now = 0;
    const v = new ResultVerifier<null>({ rate: 1, timeoutMs: 10_000, replicaClaimTimeoutMs: 2_000 }, () => 0, () => now);
    let current = v.start(subtask("s", "x"), exec("s", "a", "1", "acct-a")).subtask.id;
    const abandoners: string[] = [];
    for (let i = 1; i < 20; i += 1) {
      v.markReplicaClaimed(current, `lazy${i}`, `acct-lazy${i}`);
      abandoners.push(`acct-lazy${i}`);
      now += 2_001;
      const { replacements, abandoned } = v.reassignStalled();
      expect(abandoned).toHaveLength(1);
      if (replacements.length === 0) break;
      expect(replacements[0].request.excludeAccounts).toEqual(expect.arrayContaining(["acct-a", ...abandoners]));
      current = replacements[0].request.subtask.id;
    }
    // Stalls at 2001, 4002, 6003 are reassigned; at 8004 only 1996ms (< one claim window) is left.
    expect(abandoners).toHaveLength(4);
    expect(now).toBe(8_004);
    // Reassignment does not extend the deadline.
    now = 10_001;
    expect(v.expire()).toMatchObject([{ status: "unresolved", winners: [] }]);
  });

  it("maxReassignments is unlimited by default and can still cap it", () => {
    expect(DEFAULT_VERIFICATION.maxReassignments).toBe(Number.POSITIVE_INFINITY);
    expect(verificationConfigFromEnv({ RESULT_VERIFICATION_MAX_REASSIGNMENTS: "2" }).maxReassignments).toBe(2);
  });
});

// #105: held verifications and reputation survive a restart; the reputation cache is bounded.
describe("verifier persistence (#105)", () => {
  it("emits pending/settled/reputation changes and restores a held verification with its deadline", () => {
    let now = 0;
    const cfg = { rate: 1, timeoutMs: 10_000, replicaClaimTimeoutMs: 2_000 };
    const v = new ResultVerifier<{ n: number }>(cfg, () => 0, () => now);
    const stored = new Map<string, unknown>();
    const deltas: Array<[string, number]> = [];
    v.onChange((c) => {
      if (c.kind === "pending") stored.set(c.originalSubtaskId, JSON.parse(JSON.stringify(c.snapshot)));
      else if (c.kind === "settled") stored.delete(c.originalSubtaskId);
      else deltas.push([c.key, c.delta]);
    });
    const r1 = v.start(subtask("s", "x"), { subtaskId: "s", agentId: "a", accountId: "acct-a", ok: true, output: "1", meta: { n: 1 } });
    v.markReplicaClaimed(r1.subtask.id, "b", "acct-b"); // still open at the "restart": not an abandoner
    now = 3_000;

    const after = new ResultVerifier<{ n: number }>(cfg, () => 0, () => now);
    const next = after.restore(stored.get("s") as any);
    expect(next).not.toBeNull();
    expect(next!.subtask.id).not.toBe(r1.subtask.id);
    expect(next!.excludeAccounts).toEqual(["acct-a"]);
    expect(after.isReplica(r1.subtask.id)).toBe(false); // the old claim died with the old queue
    expect(after.restore(stored.get("s") as any)).toBeNull();
    // The original deadline holds: no replica reported, nobody abandoned -> unverified accept at 10s.
    now = 10_001;
    expect(after.expire()).toMatchObject([{ status: "timeout", output: "1", winners: [{ meta: { n: 1 } }] }]);

    // A verdict emits reputation deltas keyed on accounts, and the settled row is removed.
    const r2 = v.recordReplica(r1.subtask.id, { subtaskId: r1.subtask.id, agentId: "b", accountId: "acct-b", ok: true, output: "1", meta: { n: 2 } });
    expect(r2).toMatchObject({ status: "verified" });
    expect(stored.has("s")).toBe(false);
    expect(deltas).toEqual([["acct-a", 0.02], ["acct-b", 0.02]]);
  });

  it("the reputation cache is bounded and evicts trusted entries before penalized ones", () => {
    const book = new ReputationBook(0.5, 3);
    book.set("cheater", 0);
    for (let i = 0; i < 10; i += 1) book.set(`new${i}`, 0.52);
    expect(book.size).toBe(3);
    expect(book.get("cheater")).toBe(0);
    expect(book.get("new0")).toBe(0.5); // evicted: back to the initial value, never higher

    const v = new ResultVerifier<null>({ rate: 1, reputationCacheMax: 100 }, () => 0);
    for (let i = 0; i < 500; i += 1) v.primeReputation(`acct${i}`, 0.9);
    expect(v.reputationCacheSize()).toBe(100);
  });
});
