import { describe, expect, it } from "vitest";
import { CLAIM_TAKEN_BACK_ERROR, isClaimTakenBack, runInferenceSubtask } from "../../src/swarm/inference-runner.js";
import type { Subtask } from "../../src/common/types.js";
import type { OllamaPiece } from "../../src/inference-api/ollama.js";

/*
 * Network run 10: the coordinator took calls back from 2-slot CPU hosts (first piece overdue) and gave
 * them to other agents. Their pieces were refused (403 not_claimant) but the agents generated on for
 * up to two minutes, both slots busy and nothing pulled, and their results were refused
 * (lease_expired). The agent now stops a call the moment the coordinator says it is not its own.
 */

const subtask: Subtask = {
  id: "st-1", taskId: "inf-1", kind: "inference", language: "python", input: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  timeoutMs: 60_000, snapshotRef: "inference", requestedModel: "m:1.5b", projectMeta: { projectId: "p", resourceClass: "cpu", priority: 60 },
} as Subtask;

function refused(status: number, body: string): Error {
  const e = new Error(`POST /inference/chunks failed (${status}): ${body}`);
  (e as { statusCode?: number }).statusCode = status;
  return e;
}

/** An engine that writes a piece every 20 ms until it is aborted (or `limit` pieces). */
function engine(state: { pieces: number; aborted: boolean }, limit = 500) {
  return (_m: string, _r: unknown, signal: AbortSignal): AsyncIterable<OllamaPiece> =>
    (async function* () {
      signal.addEventListener("abort", () => (state.aborted = true), { once: true });
      for (let i = 0; i < limit && !signal.aborted; i++) {
        state.pieces++;
        yield { delta: "token ".repeat(80) };
        await new Promise((r) => setTimeout(r, 20));
      }
      yield { doneReason: "stop" as const, promptTokens: 5, outputTokens: limit };
    })();
}

describe("a call the coordinator took back", () => {
  it("recognises the refusal", () => {
    expect(isClaimTakenBack(refused(403, '{"error":"not_claimant"}'))).toBe(true);
    expect(isClaimTakenBack(refused(409, '{"status":"gap"}'))).toBe(false);
    expect(isClaimTakenBack(refused(403, '{"error":"forbidden"}'))).toBe(false);
    expect(isClaimTakenBack(new Error("network down"))).toBe(false);
  });

  it("stops at the first refused piece, frees the slot at once and sends nothing more", async () => {
    const state = { pieces: 0, aborted: false };
    const posts: unknown[] = [];
    const t0 = Date.now();
    const r = await runInferenceSubtask(subtask, {
      agentId: "a1", ollamaHost: "", chat: engine(state),
      post: async (_p, b) => { posts.push(b); throw refused(403, '{"error":"not_claimant"}'); },
    });
    expect(r).toMatchObject({ ok: false, output: "", error: CLAIM_TAKEN_BACK_ERROR });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(state.aborted).toBe(true);
    expect(state.pieces).toBeLessThan(5);
    // One refused piece; no final piece to a coordinator that no longer holds the call here.
    expect(posts).toHaveLength(1);
  });

  it("other refused pieces do not stop the call (they are sent again with the next)", async () => {
    const state = { pieces: 0, aborted: false };
    let n = 0;
    const r = await runInferenceSubtask(subtask, {
      agentId: "a1", ollamaHost: "", chat: engine(state, 5),
      post: async () => { if (n++ === 0) throw refused(500, "oops"); return { status: "ok" }; },
    });
    expect(r.ok).toBe(true);
    expect(state.aborted).toBe(false);
    expect(state.pieces).toBe(5);
  });
});
