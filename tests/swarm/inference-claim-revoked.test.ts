import { describe, expect, it } from "vitest";
import { CLAIM_REVOKED_ERROR, runInferenceSubtask } from "../../src/swarm/inference-runner.js";
import type { Subtask } from "../../src/common/types.js";

/*
 * A call the coordinator gave to another agent (a reserved machine's backfill call preempted for its
 * holder's job, docs/reservation-backfill.md): its pieces are refused as not_claimant, and the run
 * stops at once so the slot is free for the holder.
 */

const st: Subtask = {
  id: "s-revoked", taskId: "t-revoked", kind: "inference", language: "python", input: JSON.stringify({ messages: [{ role: "user", content: "hi" }], maxTokens: 64 }),
  timeoutMs: 60_000, snapshotRef: "inference", requestedModel: "m:1b", projectMeta: { projectId: "p", resourceClass: "cpu", priority: 1 },
};

function slowChat(total: number, produced: { n: number; aborted: boolean }) {
  return async function* (_model: string, _req: unknown, signal: AbortSignal) {
    for (let i = 0; i < total; i++) {
      if (signal.aborted) {
        produced.aborted = true;
        throw new Error("aborted");
      }
      produced.n++;
      await new Promise((r) => setTimeout(r, 200));
      yield { delta: `piece${i} ` };
    }
  };
}

describe("claim revoked mid-run", () => {
  it("a not_claimant answer to a piece stops the call and reports claim_revoked, with no final piece", async () => {
    const produced = { n: 0, aborted: false };
    const posted: unknown[] = [];
    const r = await runInferenceSubtask(st, {
      agentId: "a1", ollamaHost: "http://127.0.0.1:9",
      post: async (_p, body) => {
        posted.push(body);
        const err = new Error('POST /inference/chunks failed (403): {"error":"not_claimant"}');
        (err as { statusCode?: number }).statusCode = 403;
        throw err;
      },
      chat: slowChat(20, produced) as never,
    });
    expect(r).toMatchObject({ ok: false, error: CLAIM_REVOKED_ERROR });
    expect(produced.n).toBeLessThan(5);
    expect(posted.every((b) => (b as { done: boolean }).done === false)).toBe(true);
  });

  it("other failed posts keep the call running (the piece is resent with the next)", async () => {
    const produced = { n: 0, aborted: false };
    let fails = 1;
    const r = await runInferenceSubtask(st, {
      agentId: "a1", ollamaHost: "http://127.0.0.1:9",
      post: async () => {
        if (fails-- > 0) throw Object.assign(new Error("POST failed (503)"), { statusCode: 503 });
        return {};
      },
      chat: slowChat(3, produced) as never,
    });
    expect(r).toMatchObject({ ok: true });
    expect(produced.n).toBe(3);
  });
});
