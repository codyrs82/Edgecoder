import { describe, expect, it } from "vitest";
import { CANCELLED_BY_REQUESTER_ERROR, runInferenceSubtask } from "../../src/swarm/inference-runner.js";
import type { Subtask } from "../../src/common/types.js";
import type { OllamaPiece } from "../../src/inference-api/ollama.js";

/*
 * Agent side of a requester's cancel: when /inference/chunks answers `cancelled`, the agent stops
 * generating and reports what it produced (billed as any reply); with nothing produced it reports
 * cancelled_by_requester (nothing billed, never retried elsewhere).
 */

const st: Subtask = {
  id: "sub-cancel", taskId: "inf-cancel", kind: "inference", language: "python", input: JSON.stringify({ messages: [{ role: "user", content: "write a long story" }] }),
  timeoutMs: 60_000, snapshotRef: "inference", requestedModel: "qwen2.5-coder:1.5b",
  projectMeta: { projectId: "p", resourceClass: "cpu", priority: 1 },
} as Subtask;

/** A model that writes one word every 20 ms until aborted. */
function slowModel(words: number) {
  let produced = 0;
  const chat = async function* (_m: string, _r: unknown, signal: AbortSignal): AsyncIterable<OllamaPiece> {
    for (let i = 0; i < words; i++) {
      if (signal.aborted) throw new Error("aborted");
      await new Promise((r) => setTimeout(r, 20));
      if (signal.aborted) throw new Error("aborted");
      produced++;
      yield { delta: "word " } as OllamaPiece;
    }
    yield { doneReason: "stop", promptTokens: 5, outputTokens: words } as OllamaPiece;
  };
  return { chat, produced: () => produced };
}

describe("a requester's cancel on the agent", () => {
  it("stops generating and reports what it produced", async () => {
    const model = slowModel(500);
    const posted: any[] = [];
    const r = await runInferenceSubtask(st, {
      agentId: "a1", ollamaHost: "",
      chat: model.chat as never,
      post: async (_p, b) => {
        posted.push(b);
        return { status: "ok", ...(posted.length >= 2 ? { cancelled: true } : {}) };
      },
    });
    expect(r.ok).toBe(true);
    expect(r.output.length).toBeGreaterThan(0);
    expect(model.produced()).toBeLessThan(100);
    const last = posted.at(-1);
    expect(last).toMatchObject({ done: true, outputTokens: expect.any(Number), promptTokens: expect.any(Number) });
  });

  it("with nothing produced, reports cancelled_by_requester", async () => {
    const posted: any[] = [];
    let aborted!: AbortSignal;
    const chat = async function* (_m: string, _r: unknown, signal: AbortSignal): AsyncIterable<OllamaPiece> {
      aborted = signal;
      // The first piece (whitespace, sent once the flush interval passed); the coordinator answers cancelled to it.
      await new Promise((r) => setTimeout(r, 170));
      yield { delta: " " } as OllamaPiece;
      await new Promise((r) => setTimeout(r, 200));
      if (signal.aborted) throw new Error("aborted");
      yield { delta: "late" } as OllamaPiece;
    };
    const r = await runInferenceSubtask(st, { agentId: "a1", ollamaHost: "", chat: chat as never, post: async (_p, b) => (posted.push(b), { status: "ok", cancelled: true }) });
    expect(aborted.aborted).toBe(true);
    expect(r).toMatchObject({ ok: false, error: CANCELLED_BY_REQUESTER_ERROR });
  });
});
