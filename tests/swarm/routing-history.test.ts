import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { PostgresRoutingDecisionStore, type RoutingDecisionStore } from "../../src/db/routing-decision-store.js";
import { describeJob } from "../../src/inference-api/job-descriptor.js";
import { bestFit } from "../../src/swarm/coordinator/best-fit.js";
import {
  noteRoutedChunk,
  recentDecisions,
  recordDecision,
  resetRouting,
  restoreDecisions,
  ROUTING_LOG_SIZE,
  setDecisionSink,
  storedDecision,
  withoutRequesterAgents,
  type RoutingDecision,
  type StoredRoutingDecision,
} from "../../src/swarm/coordinator/routing.js";
import { worldOwnerTag } from "../../src/swarm/network-world.js";
import { DAY_MS } from "../../src/swarm/network-history.js";
import { MAX_PENDING_DECISIONS, RoutingHistory } from "../../src/swarm/routing-history.js";
import { agent, currentNetwork } from "./helpers/best-fit-network.js";

/*
 * The Network page's "Routing decisions" survive a restart (stored like the time series, #332), and
 * best fit never places a call on the requester's own agents (self-dealing).
 */

const job = describeJob({ messages: [{ role: "user", content: "fix the off-by-one in utils.ts" }] });

/** A decision through the real path: best fit on the reference network, then recorded. */
function decide(taskId: string, atMs: number): RoutingDecision {
  return recordDecision(taskId, `sub-${taskId}`, job, bestFit(job, currentNetwork()), atMs);
}

class MemoryStore implements RoutingDecisionStore {
  rows = new Map<string, StoredRoutingDecision>();
  fail = false;
  upserts = 0;
  async upsert(coordinatorId: string, decisions: readonly StoredRoutingDecision[]) {
    if (this.fail) throw new Error("connection refused");
    this.upserts++;
    for (const d of decisions) this.rows.set(`${coordinatorId}|${d.taskId}`, JSON.parse(JSON.stringify(d)));
  }
  async load(coordinatorId: string, sinceMs: number, limit: number) {
    if (this.fail) throw new Error("connection refused");
    const mine = [...this.rows.entries()].filter(([k, d]) => k.startsWith(`${coordinatorId}|`) && d.atMs >= sinceMs).map(([, d]) => d);
    return mine.sort((a, b) => a.atMs - b.atMs).slice(-limit);
  }
  async prune(beforeMs: number) {
    let n = 0;
    for (const [k, d] of this.rows) if (d.atMs < beforeMs) { this.rows.delete(k); n++; }
    return n;
  }
}

const quiet = { info: () => undefined, warn: () => undefined };
const history = (store: RoutingDecisionStore | null, coordinatorId = "coord-a") =>
  new RoutingHistory({ store, coordinatorId, retentionDays: 7, restoreLimit: ROUTING_LOG_SIZE, restoreInto: restoreDecisions, serialize: storedDecision, log: quiet });

beforeEach(() => {
  setDecisionSink(undefined);
  resetRouting();
});

describe("routing decisions are persisted and read back", () => {
  test("a decision is written when made and again with its outcome; the session key and agent id stay out", async () => {
    const store = new MemoryStore();
    const h = history(store);
    setDecisionSink((d) => h.record(d));
    const now = Date.now();
    decide("t1", now);
    expect(h.pendingCount).toBe(1);
    await h.flush();
    const first = store.rows.get("coord-a|t1")!;
    expect(first).toMatchObject({ taskId: "t1", subtaskId: "sub-t1", job: job.job, actual: {} });
    expect(first).not.toHaveProperty("sessionKey");
    expect(first).not.toHaveProperty("preferredAgentId");
    noteRoutedChunk("sub-t1", "agent-gpu-xyz123", true, undefined, now + 900);
    await h.flush();
    expect(store.rows.get("coord-a|t1")!.actual).toMatchObject({ ok: true, totalMs: 900, agent: "agent-xyz123" });
    expect(store.upserts).toBe(2);
  });

  test("after a restart the stored decisions are back in the panel, newest first", async () => {
    const store = new MemoryStore();
    const before = history(store);
    setDecisionSink((d) => before.record(d));
    const now = Date.now();
    for (let i = 0; i < 3; i++) decide(`t${i}`, now - 60_000 + i * 1_000);
    await before.stop();

    // A fresh process: empty log, then one call before the restore finishes.
    setDecisionSink(undefined);
    resetRouting();
    decide("live", now);
    const after = history(store);
    expect(await after.restore(now)).toBe(3);
    expect(recentDecisions(10).map((d) => d.taskId)).toEqual(["live", "t2", "t1", "t0"]);
    // Restored rows carry their outcome but no session or preferred agent.
    expect(recentDecisions(10)[3]).toMatchObject({ taskId: "t0", actual: {} });
  });

  test("only this coordinator's rows inside the retention come back, at most the log's size", async () => {
    const store = new MemoryStore();
    const now = Date.now();
    const d = (taskId: string, atMs: number): StoredRoutingDecision => ({ ...storedDecision(decide(taskId, atMs)) });
    resetRouting();
    await store.upsert("coord-a", [d("old", now - 8 * DAY_MS), d("recent", now - DAY_MS)]);
    await store.upsert("coord-b", [d("other", now - 1_000)]);
    resetRouting();
    expect(await history(store).restore(now)).toBe(1);
    expect(recentDecisions().map((x) => x.taskId)).toEqual(["recent"]);
    expect(await history(store).prune(now)).toBe(1);
    expect([...store.rows.keys()].sort()).toEqual(["coord-a|recent", "coord-b|other"]);

    const many = Array.from({ length: ROUTING_LOG_SIZE + 20 }, (_, i) => ({ ...storedDecision(decide(`m${i}`, now - 100_000 + i)) }));
    resetRouting();
    expect(restoreDecisions(many)).toBe(ROUTING_LOG_SIZE);
    expect(recentDecisions(1)[0].taskId).toBe(`m${ROUTING_LOG_SIZE + 19}`);
  });

  test("a failed write is kept for the next one; without a database nothing is queued", async () => {
    const store = new MemoryStore();
    const h = history(store);
    setDecisionSink((d) => h.record(d));
    store.fail = true;
    decide("t1", Date.now());
    await h.flush();
    expect(h.pendingCount).toBe(1);
    store.fail = false;
    await h.flush();
    expect(store.rows.has("coord-a|t1")).toBe(true);
    expect(await history(store).restore()).toBeGreaterThanOrEqual(0);

    const none = history(null);
    setDecisionSink((d) => none.record(d));
    decide("t2", Date.now());
    expect(none.enabled).toBe(false);
    expect(none.pendingCount).toBe(0);
    expect(MAX_PENDING_DECISIONS).toBeGreaterThan(ROUTING_LOG_SIZE);
  });
});

describe("best fit leaves the requester's own agents out", () => {
  const view = currentNetwork();
  const owners = new Map<string, string | null>([["gpu1", "acct-host"], ["mac14", "acct-host"]]);

  test("local agents by owner account, peers' by owner tag", () => {
    const peer = agent({ agentId: "peer-gpu", computeClass: "gpu", models: ["qwen3-coder:30b"], local: false, ownerTag: worldOwnerTag("acct-host") });
    const peerOther = agent({ agentId: "peer-mac", computeClass: "apple", models: ["qwen2.5-coder:7b"], local: false, ownerTag: worldOwnerTag("acct-else") });
    const kept = withoutRequesterAgents([...view.agents, peer, peerOther], "acct-host", owners).map((a) => a.agentId);
    expect(kept).not.toContain("gpu1");
    expect(kept).not.toContain("mac14");
    expect(kept).not.toContain("peer-gpu");
    expect(kept).toContain("peer-mac");
    expect(kept).toContain("mac7");
    // Anyone else sees the whole network; no requester means no filter.
    expect(withoutRequesterAgents(view.agents, "acct-buyer", owners)).toHaveLength(view.agents.length);
    expect(withoutRequesterAgents(view.agents, undefined, owners)).toHaveLength(view.agents.length);
  });

  test("a host asking for agent work is routed past its own GPU", () => {
    const hard = describeJob({ messages: [{ role: "user", content: "refactor the payment module across these files and add tests" }], tools: [{ type: "function", function: { name: "read_file", parameters: {} } }] }, { job: "agentic", quality: "best" });
    expect(bestFit(hard, view).chosen?.agentId).toBe("gpu1");
    const own = bestFit(hard, { ...view, agents: withoutRequesterAgents(view.agents, "acct-host", owners) });
    expect(own.chosen?.agentId).not.toBe("gpu1");
    expect(own.candidates.some((c) => c.agentId === "gpu1" || c.agentId === "mac14")).toBe(false);
  });
});

// The real table, when a test database is given (TEST_DATABASE_URL), like network-history.test.ts.
const PG_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("routing_decisions in Postgres", () => {
  const pool = PG_URL ? new pg.Pool({ connectionString: PG_URL }) : null;
  const coord = `test-${randomUUID()}`;
  afterAll(async () => {
    await pool?.query("DELETE FROM routing_decisions WHERE coordinator_id = $1", [coord]).catch(() => undefined);
    await pool?.end();
  });

  test("upsert replaces a task's row, load returns the newest oldest-first, prune deletes old rows", async () => {
    const store = new PostgresRoutingDecisionStore(pool!);
    const now = Date.now();
    const a = storedDecision(decide("pa", now - 2_000));
    const b = storedDecision(decide("pb", now - 1_000));
    await store.upsert(coord, [a, b]);
    await store.upsert(coord, [{ ...a, actual: { ok: true, totalMs: 1234 } }]);
    const rows = await store.load(coord, now - 60_000, 10);
    expect(rows.map((r) => r.taskId)).toEqual(["pa", "pb"]);
    expect(rows[0].actual).toEqual({ ok: true, totalMs: 1234 });
    expect((await store.load(coord, now - 60_000, 1)).map((r) => r.taskId)).toEqual(["pb"]);
    await store.upsert(coord, [storedDecision(decide("gone", now - 30 * DAY_MS))]);
    expect(await store.prune(now - 7 * DAY_MS)).toBeGreaterThanOrEqual(1);
    expect((await store.load(coord, 0, 10)).map((r) => r.taskId)).toEqual(["pa", "pb"]);
  });
});
