// Settings → Active work: the owner's own requests while they run, and this machine's agent.
import { describe, expect, it } from "vitest";
import { ActivityTracker, agentView, firstLine, stepText } from "../../src/apps/ide/activity.js";
import { botActivity, sessionActivity, tentacleActivity, networkTaskActivity } from "../../src/apps/ide/activity-routes.js";

const SERVED = { label: "m-7f3a", own: false, computeClass: "gpu", tier: "24gb", hardware: "GPU (24 GB)", region: "us-east", country: "US" };

describe("ActivityTracker", () => {
  it("follows a request: served calls, cost, tool steps, then done", () => {
    let t = 100;
    const tr = new ActivityTracker(() => t);
    const h = tr.begin({ kind: "chat", title: "\n  Fix the login bug\nmore text", source: "EdgeCoder chat", model: "auto" });
    h.event({ type: "usage", cSats: 1.5, where: "Network GPU", model: "qwen3:32b", served: SERVED });
    h.event({ type: "tool_call", id: "c1", tool: "read_file", args: { path: "src/login.ts" } });
    h.event({ type: "status", message: "Thinking…" });
    const [live] = tr.running();
    expect(live).toMatchObject({ kind: "chat", title: "Fix the login bug", status: "running", cSats: 1.5, model: "qwen3:32b", steps: ["read_file src/login.ts"], progress: "Thinking…" });
    expect(live.calls[0].served?.region).toBe("us-east");
    t = 900;
    h.end();
    h.end("failed");
    expect(tr.running()).toEqual([]);
    expect(tr.recent()[0]).toMatchObject({ status: "done", startedAtMs: 100, endedAtMs: 900 });
    expect(tr.recent()[0].progress).toBeUndefined();
  });

  it("an error event fails the request; cancelled is kept; recent is capped and filtered by kind", () => {
    const tr = new ActivityTracker();
    const a = tr.begin({ kind: "api", title: "x" });
    a.event({ type: "error", message: "No machine has qwen3:32b" });
    a.end();
    const b = tr.begin({ kind: "code", title: "y" });
    b.end("cancelled");
    expect(tr.recent(["api"]).map((i) => [i.status, i.error])).toEqual([["failed", "No machine has qwen3:32b"]]);
    expect(tr.recent(["code"])[0].status).toBe("cancelled");
    for (let i = 0; i < 250; i++) tr.begin({ kind: "api", title: String(i) }).end();
    expect(tr.recent().length).toBe(200);
  });

  it("helpers", () => {
    expect(firstLine("a".repeat(200), 10)).toBe("aaaaaaaaa…");
    expect(stepText("run_command", { command: "npm test" })).toBe("run_command npm test");
    expect(stepText("git_status", null)).toBe("git_status");
  });
});

describe("agentView", () => {
  const now = 10_000;
  it("not reachable when the forwarder did not answer", () => {
    expect(agentView(null, new Set(), now)).toMatchObject({ reachable: false, jobs: [], jobsUnknown: true });
  });

  it("shows the paused reason, slots and the jobs served, marking only the owner's own as 'you'", () => {
    const v = agentView({
      ok: true, agentId: "desktop-mac-1", coordinatorUrl: "https://coordinator.edgecoder.io", registered: true,
      steering: { url: "https://coordinator.edgecoder.io", source: "registry", region: "us-east" },
      paused: { reason: "Auto-blacklisted by behavioral monitoring: too many failed results", sinceMs: 5 }, draining: false, claims: 2,
      serving: {
        slots: { total: 2, busy: 2 }, computeClass: "apple", tier: "apple.m",
        jobs: [
          { id: "sub-abcdef123456789", taskId: "inf-mine", kind: "inference", model: "qwen3:8b", startedAtMs: 4_000, outputTokens: 120, accountId: "acct_other" },
          { id: "sub-2", taskId: "inf-theirs", kind: "inference", model: "llama3.2:3b", startedAtMs: 9_000, outputTokens: 3 },
        ],
      },
    }, new Set(["inf-mine"]), now);
    expect(v).toMatchObject({ reachable: true, registered: true, region: "us-east", draining: false, claims: 2, slots: { total: 2, busy: 2 }, computeClass: "apple", jobsUnknown: false });
    expect(v.paused?.reason).toContain("too many failed results");
    expect(v.jobs.map((j) => [j.requester, j.model, j.elapsedMs, j.outputTokens])).toEqual([["you", "qwen3:8b", 6_000, 120], ["network", "llama3.2:3b", 1_000, 3]]);
    // Nothing that identifies the job's task or anyone's account reaches the app.
    const text = JSON.stringify(v);
    expect(text).not.toContain("inf-theirs");
    expect(text).not.toContain("acct_other");
    expect(v.jobs[0].id.length).toBeLessThanOrEqual(12);
  });

  it("carries the host memory guard (paused for memory, loaded and served models)", () => {
    const v = agentView({ ok: true, registered: true, memory: { pressure: "warning", paused: true, pausedReason: "memory_pressure", totalBytes: 48e9, budgetBytes: 28e9, usedBytes: 9e9, loadedModels: ["qwen3.5:9b"], servingModels: ["qwen3.5:9b"], localOnlyModels: [], tooBigModels: ["llama3.3:70b"], contextWindow: 32768, parallel: 2 } }, new Set(), now);
    expect(v.memory).toMatchObject({ pressure: "warning", paused: true, loadedModels: ["qwen3.5:9b"], servingModels: ["qwen3.5:9b"], tooBigModels: ["llama3.3:70b"] });
    expect(agentView({ ok: true, memory: { pressure: "bogus" } }, new Set(), now).memory).toBeNull();
  });

  it("an older agent without serving: jobs unknown", () => {
    expect(agentView({ ok: true, registered: true }, new Set(), now)).toMatchObject({ jobsUnknown: true, slots: null });
  });
});

describe("running work from other stores", () => {
  it("a session turn", () => {
    const a = sessionActivity({ id: "s1", title: "auth refactor", model: "auto", origin: "terminal", updatedAt: 50 }, {
      turnId: "t1", text: "Split the auth module", events: [{ type: "usage", cSats: 2, where: "Network", served: SERVED }, { type: "tool_call", tool: "edit_file" }],
    });
    expect(a).toMatchObject({ kind: "code", title: "Split the auth module", source: "edgecoder code · auth refactor", cSats: 2, steps: ["edit_file"] });
    expect(sessionActivity({ id: "s1", title: "t", model: "m", origin: "desktop", updatedAt: 0 }, null)).toBeNull();
  });

  it("a bot run, a helper, a network job", () => {
    expect(botActivity({ id: "b", name: "Harry", status: "needs_approval", lastRun: { id: "r1", trigger: "schedule", startedAtMs: 1, cSats: 0.5, where: "This computer" } })).toMatchObject({ kind: "bot", source: "Harry", progress: "Waiting for your approval" });
    expect(botActivity({ id: "b", name: "Harry", status: "idle" })).toBeNull();
    expect(tentacleActivity({ id: "t1", task: "Write tests", status: "queued", progress: "", createdAt: 3, cSats: 0 }, "s")).toMatchObject({ kind: "tentacle", progress: "Waiting for a free helper slot" });
    expect(tentacleActivity({ id: "t1", task: "Write tests", status: "passed", progress: "", createdAt: 3, cSats: 0 }, "s")).toBeNull();
    expect(networkTaskActivity({ id: "j", prompt: "sum primes", state: "running", submittedAtMs: 1 })).toMatchObject({ kind: "chat", title: "sum primes" });
  });
});
