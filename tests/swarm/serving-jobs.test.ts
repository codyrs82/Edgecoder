import { describe, expect, it } from "vitest";
import { ServingJobs } from "../../src/swarm/serving-jobs.js";

describe("serving jobs (Settings → Active work)", () => {
  it("lists running jobs with the model, start time and tokens so far, and forgets them when they end", () => {
    let t = 1_000;
    const jobs = new ServingJobs(() => t);
    const a = jobs.start({ id: "sub-1", taskId: "inf-1", kind: "inference", requestedModel: "qwen3:8b" });
    t = 2_000;
    const b = jobs.start({ id: "sub-2", taskId: "task-2", kind: "single_step" });
    a.delta("x".repeat(41));
    const v = jobs.view(2);
    expect(v.jobs).toEqual([
      { id: "sub-1", taskId: "inf-1", kind: "inference", model: "qwen3:8b", startedAtMs: 1_000, outputTokens: 11 },
      { id: "sub-2", taskId: "task-2", kind: "code", model: null, startedAtMs: 2_000, outputTokens: 0 },
    ]);
    expect(v.slots).toEqual({ total: 2, busy: 1 });
    a.end();
    a.end();
    b.end();
    expect(jobs.view(2).jobs).toEqual([]);
    expect(jobs.view(2).slots.busy).toBe(0);
  });

  it("keeps the class and tier the coordinator granted, ignoring junk", () => {
    const jobs = new ServingJobs();
    jobs.setGrant("apple", "apple.m");
    jobs.setGrant(undefined, 42);
    expect(jobs.view(1)).toMatchObject({ computeClass: "apple", tier: "apple.m" });
  });

  it("never carries the prompt", () => {
    const jobs = new ServingJobs();
    jobs.start({ id: "s", taskId: "t", kind: "inference", requestedModel: "m", input: "secret prompt" } as never);
    expect(JSON.stringify(jobs.view(1))).not.toContain("secret prompt");
  });
});
