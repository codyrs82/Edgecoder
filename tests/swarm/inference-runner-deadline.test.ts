import { describe, expect, it } from "vitest";
import { runInferenceSubtask } from "../../src/swarm/inference-runner.js";
import type { Subtask } from "../../src/common/types.js";
import type { OllamaPiece } from "../../src/inference-api/ollama.js";

/*
 * Run 4 (agent_lost_mid_reply at ~210 s): the coordinator's claim lease ends at claim + timeout +
 * grace, but the agent counted its timeout from when the call started running, and stopped reading
 * the engine only when the engine honoured the abort. A reply still streaming at claim + 210 s was
 * cut as agent_lost_mid_reply. The agent now counts from the claim and stops at its deadline even
 * when the engine keeps going.
 */

const subtask = (timeoutMs: number): Subtask => ({
  id: "st-1", taskId: "inf-1", kind: "inference", language: "python", input: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  timeoutMs, snapshotRef: "inference", requestedModel: "m:1.5b", projectMeta: { projectId: "p", resourceClass: "cpu", priority: 60 },
} as Subtask);

/** An engine that sends one piece and then never ends, whatever the abort signal says. */
const stuck = (calls: { n: number }) => (_m: string, _r: unknown, _s: AbortSignal): AsyncIterable<OllamaPiece> => {
  calls.n++;
  return (async function* () {
    yield { delta: "partial reply" };
    await new Promise(() => undefined);
  })();
};

describe("the agent's deadline", () => {
  it("counts from the claim and holds when the engine ignores the abort", async () => {
    const posted: any[] = [];
    const calls = { n: 0 };
    const t0 = Date.now();
    // Claimed 8.5 s ago (it waited on this host): 1.5 s of its 10 s are left.
    const r = await runInferenceSubtask(subtask(10_000), { agentId: "a1", ollamaHost: "", claimedAtMs: t0 - 8_500, post: async (_p, b) => { posted.push(b); return {}; }, chat: stuck(calls) });
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(1_300);
    expect(took).toBeLessThan(4_000);
    expect(r).toMatchObject({ ok: false, output: "partial reply", error: "timed out after 10 s" });
    // The requester got the part and the deadline as the last piece.
    expect(posted.at(-1)).toMatchObject({ done: true, error: "timed out after 10 s" });
    expect(posted.map((p) => p.delta).join("")).toBe("partial reply");
  }, 10_000);

  it("a call whose time ran out before it could start is not run (nothing sent; the coordinator may run it elsewhere)", async () => {
    const posted: unknown[] = [];
    const calls = { n: 0 };
    const r = await runInferenceSubtask(subtask(10_000), { agentId: "a1", ollamaHost: "", claimedAtMs: Date.now() - 10_500, post: async (_p, b) => { posted.push(b); return {}; }, chat: stuck(calls) });
    expect(r).toMatchObject({ ok: false, output: "", error: "timed out after 10 s" });
    expect(calls.n).toBe(0);
    expect(posted).toEqual([]);
  });

  it("without a claim time it counts from the start, as before", async () => {
    const r = await runInferenceSubtask(subtask(10_000), {
      agentId: "a1", ollamaHost: "", post: async () => ({}),
      chat: () => (async function* (): AsyncGenerator<OllamaPiece> {
        yield { delta: "whole" };
        yield { doneReason: "stop", promptTokens: 3, outputTokens: 1 };
      })(),
    });
    expect(r).toMatchObject({ ok: true, output: "whole" });
  });
});
