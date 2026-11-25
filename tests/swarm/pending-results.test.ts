import { describe, expect, it } from "vitest";
import { flushPendingResultBuffer, isPermanentResultRefusal, type PendingResultStore } from "../../src/swarm/pending-results.js";

/** An in-memory stand-in for the worker's sqlite buffer (src/db/sqlite-store.ts). */
function store(ids: string[]): PendingResultStore & { rows: Map<string, { payload: string; attempts: number }> } {
  const rows = new Map(ids.map((id) => [id, { payload: JSON.stringify({ subtaskId: id }), attempts: 0 }]));
  return {
    rows,
    listPendingResults: (limit = 20) => [...rows.entries()].slice(0, limit).map(([subtaskId, r]) => ({ subtaskId, ...r })),
    markResultSynced: (id) => void rows.delete(id),
    incrementResultAttempt: (id) => {
      const r = rows.get(id);
      if (r) r.attempts += 1;
    },
  };
}

const httpError = (status: number, body: string) => Object.assign(new Error(`POST /result failed (${status}): ${body}`), { statusCode: status });
const quiet = () => {
  const lines: string[] = [];
  return { lines, log: { info: (m: string) => void lines.push(m), warn: (m: string) => void lines.push(m) } };
};

describe("worker: buffered results", () => {
  it("drops a result refused with 409 lease_expired (logged once) and goes on with the rest", async () => {
    const s = store(["late-1", "ok-2", "ok-3"]);
    const { lines, log } = quiet();
    const sent: string[] = [];
    const out = await flushPendingResultBuffer(s, async (p) => {
      const id = (p as { subtaskId: string }).subtaskId;
      if (id === "late-1") throw httpError(409, JSON.stringify({ error: "lease_expired" }));
      sent.push(id);
      return { ok: true };
    }, log);
    expect(out).toEqual({ flushed: ["ok-2", "ok-3"], dropped: ["late-1"] });
    expect(sent).toEqual(["ok-2", "ok-3"]);
    expect(s.rows.size).toBe(0);
    expect(lines.filter((l) => l.includes("late-1") && l.includes("lease_expired"))).toHaveLength(1);
    // Nothing is left to retry: a second flush sends nothing.
    expect(await flushPendingResultBuffer(s, async () => { throw new Error("must not be called"); }, log)).toEqual({ flushed: [], dropped: [] });
  });

  it("keeps a result whose delivery failed for another reason, and stops there", async () => {
    const s = store(["a", "b"]);
    const { log } = quiet();
    const out = await flushPendingResultBuffer(s, async () => { throw httpError(503, "{}"); }, log);
    expect(out).toEqual({ flushed: [], dropped: [], stoppedAt: "a" });
    expect(s.rows.get("a")?.attempts).toBe(1);
    expect(s.rows.has("b")).toBe(true);
  });

  it("only 409 lease_expired is a permanent refusal", () => {
    expect(isPermanentResultRefusal(httpError(409, JSON.stringify({ error: "lease_expired" })))).toBe(true);
    expect(isPermanentResultRefusal(httpError(409, JSON.stringify({ error: "forward_in_progress" })))).toBe(false);
    expect(isPermanentResultRefusal(httpError(429, JSON.stringify({ error: "agent_rate_limited" })))).toBe(false);
    expect(isPermanentResultRefusal(new Error("timeout"))).toBe(false);
    expect(isPermanentResultRefusal(undefined)).toBe(false);
  });
});
