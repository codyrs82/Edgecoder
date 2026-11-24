import { describe, expect, it } from "vitest";
import { NetworkInferenceError, streamNetworkCompletion, type NetworkDeps } from "../../src/apps/ide/network-inference.js";

/*
 * A coordinator stopping for a deploy refuses a new call with 503 coordinator_draining before
 * anything is set aside or charged. The client sends it once more after the short wait; a second
 * refusal is a clear, retryable error that says nothing was charged.
 */
function depsWith(submitAnswers: Array<{ status: number; json: Record<string, unknown> }>) {
  const calls: string[] = [];
  const deps: NetworkDeps = {
    forwarder: "",
    token: () => "",
    agentId: "acct-u1",
    transport: async (_method, path) => {
      calls.push(path);
      if (path === "/inference/submit") return submitAnswers.shift() ?? { status: 500, json: { error: "unexpected" } };
      return { status: 200, json: { chunks: ["hello"], next: 1, done: true, creditsSpent: 2 } };
    }
  };
  return { deps, calls };
}
const draining = { status: 503, json: { error: "coordinator_draining", retryable: true, retryAfterMs: 1, charged: false } };
const req = { model: "qwen3-coder:30b", computeClass: "any", messages: [{ role: "user", content: "hi" }] };

describe("network inference on a draining coordinator", () => {
  it("retries once after the wait and streams the reply", async () => {
    const { deps, calls } = depsWith([draining, { status: 200, json: { subtaskId: "s1" } }]);
    const pieces = [];
    for await (const p of streamNetworkCompletion(deps, req)) pieces.push(p);
    expect(calls).toEqual(["/inference/submit", "/inference/submit", "/inference/stream"]);
    expect(pieces).toEqual([{ delta: "hello" }, { done: true, creditsSpent: 2 }]);
  });

  it("a second refusal is a retryable 503 that says nothing was charged (no third try)", async () => {
    const { deps, calls } = depsWith([draining, draining]);
    const err = await (async () => {
      try {
        for await (const _ of streamNetworkCompletion(deps, req)) void _;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(NetworkInferenceError);
    expect((err as NetworkInferenceError).status).toBe(503);
    expect((err as NetworkInferenceError).retryAfterSec).toBe(1);
    expect((err as Error).message).toContain("Nothing was charged");
    expect(calls).toEqual(["/inference/submit", "/inference/submit"]);
  });
});
