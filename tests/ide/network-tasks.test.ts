import { describe, expect, it } from "vitest";
import { NetworkTasks, type SwarmClient } from "../../src/apps/ide/network-tasks.js";
import { SwarmPostSubmitError } from "../../src/model/router.js";

function fakeSwarm() {
  const results = new Map<string, { output: string; ok?: boolean; error?: string; creditsSpent?: number } | null>();
  let n = 0;
  const swarm: SwarmClient = {
    submitSwarm: async () => { n++; return { taskId: `t${n}`, subtaskId: `s${n}` }; },
    pollSwarm: async (taskId) => results.get(taskId) ?? null,
  };
  return { swarm, results };
}

describe("NetworkTasks", () => {
  it("tracks a job from submit to its result, newest first", async () => {
    const { swarm, results } = fakeSwarm();
    let now = 1000;
    const tasks = new NetworkTasks(swarm, () => now);
    const a = await tasks.submit("print hello");
    await tasks.submit("print 2+2", "javascript");
    expect(a).toMatchObject({ id: "t1", state: "running", prompt: "print hello", language: "python" });
    expect(tasks.list().map((t) => t.id)).toEqual(["t2", "t1"]);

    results.set("t1", { output: "hello\n", ok: true, creditsSpent: 1 });
    now = 5000;
    await tasks.pollOnce();
    const t1 = tasks.list().find((t) => t.id === "t1")!;
    expect(t1).toMatchObject({ state: "done", output: "hello\n", creditsSpent: 1, finishedAtMs: 5000 });
    expect(tasks.list().find((t) => t.id === "t2")!.state).toBe("running");
    expect(JSON.stringify(tasks.list())).not.toContain("subtaskId");
  });

  it("marks failures and jobs that never finish", async () => {
    const { swarm, results } = fakeSwarm();
    let now = 0;
    const tasks = new NetworkTasks(swarm, () => now);
    await tasks.submit("a");
    await tasks.submit("b");
    results.set("t1", { output: "", ok: false, error: "Blocked AST node: Import" });
    now = 60_000;
    await tasks.pollOnce();
    expect(tasks.list().find((t) => t.id === "t1")).toMatchObject({ state: "failed", error: "Blocked AST node: Import" });
    now = 16 * 60_000;
    await tasks.pollOnce();
    expect(tasks.list().map((t) => [t.id, t.state])).toEqual([["t2", "timed_out"], ["t1", "failed"]]);
  });

  it("a failure after the request went out says the job may still run", async () => {
    const tasks = new NetworkTasks({
      submitSwarm: async () => { throw new SwarmPostSubmitError("Swarm submit outcome unknown (timeout)", "t9"); },
      pollSwarm: async () => null,
    });
    await expect(tasks.submit("x")).rejects.toThrow(/may still run/);
  });
});
