import { describe, expect, it } from "vitest";
import { runInferenceSubtask } from "../../src/swarm/inference-runner.js";
import { networkBackend } from "../../src/inference-api/backends.js";
import type { NetworkDeps } from "../../src/apps/ide/network-inference.js";
import type { ChatPiece } from "../../src/inference-api/types.js";
import type { Subtask } from "../../src/common/types.js";
import type { OllamaPiece } from "../../src/inference-api/ollama.js";

/*
 * Run 5: DeepSeek Flash replies cut at the caller's max_tokens reached the client with finish_reason
 * "stop" (outputTokens 2112). The agent dropped the engine's done reason, the coordinator had no
 * field for it, and the network backend never set stopReason. Now the reason goes agent -> chunks ->
 * stream read -> network backend -> finish_reason "length".
 */

const subtask = (): Subtask => ({
  id: "st-f", taskId: "inf-f", kind: "inference", language: "python", input: JSON.stringify({ messages: [{ role: "user", content: "hi" }], maxTokens: 2_048 }),
  timeoutMs: 60_000, snapshotRef: "inference", requestedModel: "deepseek-v4.1-flash", projectMeta: { projectId: "p", resourceClass: "gpu", priority: 60 },
} as Subtask);

async function collect(it: AsyncIterable<ChatPiece>): Promise<ChatPiece[]> {
  const out: ChatPiece[] = [];
  for await (const p of it) out.push(p);
  return out;
}

describe("a reply cut at max_tokens says so end to end", () => {
  it("the agent sends the engine's done reason with its last piece", async () => {
    for (const reason of ["length", "stop"] as const) {
      const posted: any[] = [];
      await runInferenceSubtask(subtask(), {
        agentId: "a1", ollamaHost: "", post: async (_p, b) => { posted.push(b); return {}; },
        chat: () => (async function* (): AsyncGenerator<OllamaPiece> {
          yield { delta: "an answer" };
          yield { doneReason: reason, promptTokens: 10, outputTokens: 2_112 };
        })(),
      });
      expect(posted.at(-1)).toMatchObject({ done: true, outputTokens: 2_112, finishReason: reason });
    }
  });

  it("the coordinator's reason: the agent's word, else output at the cap (agents before the field)", async () => {
    const { replyFinishReason } = await import("../../src/swarm/coordinator/routes/inference.js");
    expect(replyFinishReason({ finishReason: "length" }, undefined)).toBe("length");
    expect(replyFinishReason({ finishReason: "stop", outputTokens: 4_000 }, 2_048)).toBe("stop");
    expect(replyFinishReason({ outputTokens: 2_112 }, 2_048)).toBe("length");
    expect(replyFinishReason({ outputTokens: 300 }, 2_048)).toBe("stop");
    expect(replyFinishReason({ outputTokens: 300 }, undefined)).toBe("stop");
  });

  it("the network backend turns the stream's finishReason into stopReason", async () => {
    const run = (finishReason?: string) => {
      const deps: NetworkDeps = {
        forwarder: "", token: () => "", agentId: "acct-1",
        transport: async (_m, path) => (path === "/inference/submit" ? { status: 200, json: { taskId: "t", subtaskId: "s" } } : { status: 200, json: { chunks: ["part"], next: 1, done: true, ...(finishReason ? { finishReason } : {}) } }),
      };
      return collect(networkBackend(deps, { model: "deepseek-v4.1-flash", computeClass: "any" })({ messages: [{ role: "user", content: "x" }] }));
    };
    expect((await run("length")).at(-1)).toMatchObject({ done: true, stopReason: "length" });
    expect((await run("stop")).at(-1)).not.toHaveProperty("stopReason");
    expect((await run()).at(-1)).not.toHaveProperty("stopReason");
  });
});
