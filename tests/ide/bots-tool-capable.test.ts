import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GO_AHEAD, asksToAct, listsSteps, runAgentLoop, type ChatFn } from "../../src/apps/ide/agent-loop.js";
import { BOT_AGENT_MIN_PARAMS_B, BotManager, botComputeChat, type BotRunner } from "../../src/apps/ide/bots.js";
import { DEFAULT_QUALITY_FLOOR, planRoutes, rankRoutes, routeModelId, sizeWorkload, type PlanOptions, type Route, type RouteInputs } from "../../src/inference-api/auto-route.js";
import { autoBackend } from "../../src/inference-api/backends.js";
import { describeJob } from "../../src/inference-api/job-descriptor.js";
import type { ChatPiece } from "../../src/inference-api/types.js";
import {
  NO_TOOL_FAMILIES, TOOL_FAMILIES, clearReportedCapabilities, parseShowCapabilities, refreshOllamaCapabilities, reportedCapabilities, supportsTools, toolSupport,
} from "../../src/model/tool-support.js";
import { bestFit, type NetworkView } from "../../src/swarm/coordinator/best-fit.js";
import { AGENTIC_LOOP, SIMPLE_QA } from "../helpers/job-fixtures.js";
import { agent, currentNetwork } from "../swarm/helpers/best-fit-network.js";

afterEach(() => clearReportedCapabilities());

/** The owner's machine: Harry ran on deepseek-r1:14b, a reasoning model that writes plans and calls no tools. */
const OWNER_LOCAL = ["deepseek-r1:14b", "qwen2.5-coder:7b", "qwen3.5:9b"];
const agentStep = sizeWorkload({ messages: [{ role: "user", content: "read all of the files in those folders" }], tools: [{ type: "function", function: { name: "read_file" } }] }, DEFAULT_QUALITY_FLOOR);
const chatStep = sizeWorkload({ messages: [{ role: "user", content: "summarize what a mutex is" }] }, DEFAULT_QUALITY_FLOOR);
const base: RouteInputs = { localModels: OWNER_LOCAL, myModels: [], leases: [], networkModels: [], classPrice: { cpu: 0.009, apple: 0.052, gpu: 0.043, "gpu.dc": 0.304 } };
const where = (rs: Route[]) => rs.map((r) => `${r.placement}:${r.model}${r.fallback ? ":fallback" : ""}`);

describe("tool support: Ollama /api/show capabilities, then the fallback lists", () => {
  /** Recorded /api/show replies (Ollama 0.6+ adds `capabilities`; older versions have none). */
  const SHOW: Record<string, { status: number; body: unknown }> = {
    "qwen3.5:9b": { status: 200, body: { modelfile: "…", details: { family: "qwen35" }, capabilities: ["completion", "vision", "tools", "thinking"] } },
    "deepseek-r1:14b": { status: 200, body: { details: { family: "qwen2" }, capabilities: ["completion", "tools", "thinking"] } },
    "my-finetune:13b": { status: 200, body: { details: { family: "llama" }, capabilities: ["completion"] } },
    "old-ollama:7b": { status: 200, body: { details: { family: "llama" } } },
  };
  const fakeFetch = (asked: string[]) =>
    (async (_url: string, init?: { body?: string }) => {
      const { model } = JSON.parse(init?.body ?? "{}") as { model: string };
      asked.push(model);
      const r = SHOW[model] ?? { status: 404, body: { error: "not found" } };
      return { ok: r.status === 200, status: r.status, json: async () => r.body };
    }) as unknown as typeof fetch;

  it("reads capabilities from /api/show and caches them", async () => {
    expect(parseShowCapabilities(SHOW["qwen3.5:9b"].body)).toEqual(["completion", "vision", "tools", "thinking"]);
    expect(parseShowCapabilities(SHOW["old-ollama:7b"].body)).toBeUndefined();
    const asked: string[] = [];
    const models = ["qwen3.5:9b", "deepseek-r1:14b", "my-finetune:13b", "old-ollama:7b", "missing:7b"];
    await refreshOllamaCapabilities(models, { fetch: fakeFetch(asked), host: "http://ollama" });
    expect(asked.sort()).toEqual([...models].sort());
    expect(reportedCapabilities("qwen3.5:9b")).toContain("tools");
    expect(toolSupport("qwen3.5:9b")).toEqual({ tools: true, source: "runtime" });
    // The runtime says this one can't: believed over "unknown models count as able".
    expect(toolSupport("my-finetune:13b")).toEqual({ tools: false, source: "runtime" });
    // No capabilities (older Ollama) or no answer: the lists decide.
    expect(toolSupport("old-ollama:7b").source).toBe("unknown");
    // Cached: a second refresh asks only for the models that had no answer.
    const again: string[] = [];
    await refreshOllamaCapabilities(models, { fetch: fakeFetch(again), host: "http://ollama" });
    expect(again.sort()).toEqual(["missing:7b", "old-ollama:7b"]);
  });

  it("deepseek-r1 never counts for an agent step, even when Ollama says 'tools'", async () => {
    await refreshOllamaCapabilities(["deepseek-r1:14b"], { fetch: fakeFetch([]) });
    expect(reportedCapabilities("deepseek-r1:14b")).toContain("tools");
    expect(toolSupport("deepseek-r1:14b")).toEqual({ tools: false, source: "denylist" });
  });

  it("without runtime data: the catalog, then the family lists", () => {
    expect(supportsTools("deepseek-r1:14b")).toBe(false);
    expect(supportsTools("deepseek-r1:7b")).toBe(false);
    expect(supportsTools("deepseek-r1:70b")).toBe(false);
    expect(supportsTools("qwen2.5-coder:7b")).toBe(true);
    expect(supportsTools("qwen3.5:9b")).toBe(true);
    expect(supportsTools("qwen3-coder:30b")).toBe(true);
    expect(toolSupport("qwen3:8b")).toEqual({ tools: true, source: "allowlist" });
    expect(toolSupport("llama3.1:8b")).toEqual({ tools: true, source: "allowlist" });
    expect(toolSupport("llama3:8b")).toEqual({ tools: false, source: "denylist" });
    expect(toolSupport("hf.co/someone/deepseek-r1:Q4_K_M").tools).toBe(false);
    expect(TOOL_FAMILIES.some((f) => NO_TOOL_FAMILIES.includes(f))).toBe(false);
  });
});

describe("ranking for a bot's agent step (Auto / Local first, BOT_AGENT_MIN_PARAMS_B)", () => {
  const opts = (o: PlanOptions = {}): PlanOptions => ({ agentMinParamsB: BOT_AGENT_MIN_PARAMS_B, ...o });
  const net = [
    { model: "deepseek-r1:14b", classes: ["gpu", "apple"], cSatsPerMTokens: { input: 70, output: 200 } },
    { model: "qwen3-coder:30b", classes: ["gpu"], cSatsPerMTokens: { input: 100, output: 400 } },
  ];

  it("skips deepseek-r1:14b: no budget left, the tool-capable local 9B does it, and says why", () => {
    for (const policy of ["auto", "local_first"] as const) {
      const routes = planRoutes(agentStep, base, policy, opts({ allowanceCSats: 0 }));
      expect(where(routes)).toEqual(["local:qwen3.5:9b:fallback"]);
      expect(routes[0].why).toBe("tools needed; local deepseek-r1:14b has no tool support");
    }
  });

  it("with budget: the network's tool-capable model first, the local 9B last, never deepseek-r1", () => {
    const routes = where(planRoutes(agentStep, { ...base, balanceCSats: 500, networkModels: net }, "auto", opts({ allowanceCSats: 100 })));
    expect(routes[0]).toBe("network:qwen3-coder:30b");
    expect(routes.at(-1)).toBe("local:qwen3.5:9b:fallback");
    expect(routes.some((r) => r.includes("deepseek-r1"))).toBe(false);
  });

  it("a tool-capable local model ≥14B still comes first (free)", () => {
    const routes = planRoutes(agentStep, { ...base, localModels: [...OWNER_LOCAL, "qwen3-coder:30b"], balanceCSats: 500, networkModels: net }, "auto", opts({ allowanceCSats: 100 }));
    expect(where(routes)[0]).toBe("local:qwen3-coder:30b");
  });

  it("never a non-tool model for an agent step, even as the last resort", () => {
    const only: RouteInputs = { ...base, localModels: ["deepseek-r1:14b"], myModels: ["deepseek-r1:7b"] };
    for (const policy of ["auto", "local_first", "local_only", "mine_only"] as const) expect(planRoutes(agentStep, only, policy, opts())).toEqual([]);
  });

  it("chat steps (no tools) may still use the reasoning model", () => {
    expect(rankRoutes(chatStep, { ...base, localModels: ["deepseek-r1:14b"] })[0].model).toBe("deepseek-r1:14b");
    expect(planRoutes(chatStep, base, "auto", opts())[0].why).toBeUndefined();
  });

  it("the reply footer says why, and a plan-only escalation skips the excluded route", async () => {
    const ran: string[] = [];
    const backend = (exclude?: string[]) =>
      autoBackend({
        inputs: async () => ({ ...base, balanceCSats: 500, networkModels: net }),
        policy: "auto",
        plan: () => opts({ allowanceCSats: 100, ...(exclude ? { exclude } : {}) }),
        run: (r) => async function* () {
          ran.push(routeModelId(r));
          yield { delta: "ok" };
          yield { done: true };
        },
        networkBestFit: () => async function* () {
          ran.push("best-fit");
          yield { delta: "ok" };
          yield { done: true, where: "network gpu · qwen3-coder:30b" };
        },
      });
    const pieces: ChatPiece[] = [];
    const req = { messages: [{ role: "user" as const, content: "read the files" }], tools: [{ type: "function" as const, function: { name: "read_file" } }] };
    for await (const p of backend()(req)) pieces.push(p);
    expect(ran).toEqual(["best-fit"]);
    expect(pieces.at(-1)).toMatchObject({ where: "network gpu · qwen3-coder:30b (tools needed; local deepseek-r1:14b has no tool support)" });
    // Escalating past the best fit: the next place in the ranking.
    for await (const _ of backend(["network/auto@any"])(req)) void _;
    expect(ran.at(-1)).toBe("network/qwen3-coder:30b@gpu");
  });
});

describe("network best fit with needsTools", () => {
  it("an agentic job skips deepseek-r1:14b; a plain chat may use it", () => {
    const view: NetworkView = { ...currentNetwork(), agents: [
      agent({ agentId: "r1", computeClass: "gpu", models: ["deepseek-r1:14b"], tokensPerSec: 60 }),
      agent({ agentId: "q1", computeClass: "gpu", models: ["qwen3-coder:30b"], tokensPerSec: 30 }),
    ] };
    const agentic = bestFit(describeJob(SIMPLE_QA, { job: "agentic" }), view);
    expect(agentic.requirements.needsTools).toBe(true);
    expect(agentic.chosen?.model).toBe("qwen3-coder:30b");
    expect(agentic.candidates.some((c) => c.model === "deepseek-r1:14b")).toBe(false);
    expect(bestFit(describeJob(AGENTIC_LOOP), view).chosen?.model).toBe("qwen3-coder:30b");
    const onlyR1: NetworkView = { ...view, agents: [view.agents[0]] };
    expect(bestFit(describeJob(SIMPLE_QA, { job: "agentic" }), onlyR1).rejected).toMatch(/no available model calls tools/);
    const chat = bestFit(describeJob(SIMPLE_QA, { needsTools: false }), view);
    expect(chat.requirements.needsTools).toBe(false);
    expect(chat.candidates.some((c) => c.model === "deepseek-r1:14b")).toBe(true);
  });
});

describe("plans without action", () => {
  const PLAN = [
    "To read all of the files in your home folder, here's how I'll approach it:",
    "",
    "1. **Identify Relevant Files**: List the folders and the files in each.",
    "2. **Read and Summarize**: Open each file and note what it's for.",
    "3. **Proceed Methodically**: Work through them one folder at a time.",
  ].join("\n");

  it("recognises a numbered plan and a request to act", () => {
    expect(listsSteps(PLAN)).toBe(true);
    expect(listsSteps("Plan:\nlook at things")).toBe(true);
    expect(listsSteps("1. Option A\n2. Option B\n\nWhich do you prefer?")).toBe(false);
    expect(listsSteps("Done: read 4 files.")).toBe(false);
    expect(asksToAct("do it")).toBe(true);
    expect(asksToAct("its your home folder, read all of the files in those folders")).toBe(true);
    expect(asksToAct("what is a mutex")).toBe(false);
  });

  it("go-ahead on a plan, then one retry on the next model, which calls the tools", async () => {
    let model = "qwen3.5:9b";
    const seen: Array<{ model: string; last: string }> = [];
    const chat: ChatFn = async (req) => {
      seen.push({ model, last: req.messages.at(-1)!.content });
      if (model === "qwen3.5:9b") return { content: PLAN, toolCalls: [] };
      return seen.filter((s) => s.model !== "qwen3.5:9b").length === 1 ? { content: "", toolCalls: [{ name: "list_directory", arguments: { path: "." } }] } : { content: "Read 3 files.", toolCalls: [] };
    };
    const ran: string[] = [];
    const events: string[] = [];
    let escalations = 0;
    await runAgentLoop({
      chat, systemPrompt: () => "", messages: [{ role: "user", content: "do it" }],
      sendEvent: (e) => void (e.type === "status" && events.push(e.message)), isCancelled: () => false,
      runTool: async (t) => (ran.push(t), "a.md\nb.md"), continueOnIntent: true,
      escalate: () => (escalations++, (model = "network/auto@any"), true),
    });
    expect(seen.map((s) => s.model)).toEqual(["qwen3.5:9b", "qwen3.5:9b", "network/auto@any", "network/auto@any"]);
    expect(seen[1].last).toBe(GO_AHEAD);
    // The next model gets the same conversation, ending with the go-ahead.
    expect(seen[2].last).toBe(GO_AHEAD);
    expect(escalations).toBe(1);
    expect(ran).toEqual(["list_directory"]);
    expect(events.some((m) => /didn't use any tools; trying the next model/.test(m))).toBe(true);
  });

  it("nowhere to escalate: the run ends after the go-ahead (no loop)", async () => {
    let n = 0;
    await runAgentLoop({
      chat: async () => (n++, { content: PLAN, toolCalls: [] }), systemPrompt: () => "", messages: [{ role: "user", content: "do it" }],
      sendEvent: () => undefined, isCancelled: () => false, runTool: async () => "ok", continueOnIntent: true, escalate: () => false,
    });
    expect(n).toBe(2);
  });

  it("a bot's escalate leaves the last route out and the run details say why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bots-tools-"));
    const plans: PlanOptions[] = [];
    const runner: BotRunner = async (ctx) => {
      const chat = botComputeChat(ctx, (_policy, plan, onRoute) => async function* () {
        const p = plan();
        plans.push(p);
        const r: Route = p.exclude?.length
          ? { placement: "network", model: "auto", computeClass: "any", cSatsPerSecond: 0, bestFit: true, reason: "network · best fit" }
          : { placement: "local", model: "qwen3.5:9b", cSatsPerSecond: 0, fallback: true, reason: "this computer · qwen3.5:9b", why: "tools needed; local deepseek-r1:14b has no tool support" };
        onRoute(r);
        yield { delta: "ok" };
        yield { done: true };
      });
      await chat({ messages: [{ role: "user", content: "do it" }] });
      expect(chat.escalate?.()).toBe(true);
      await chat({ messages: [{ role: "user", content: "do it" }] });
    };
    const m = new BotManager({ runner, file: join(dir, "bots.json") });
    try {
      const bot = m.create({ name: "Harry", projectRoot: dir, budgetCSatsPerDay: 100 });
      m.runNow(bot.id);
      await m.idle(bot.id);
      expect(plans[0].exclude).toBeUndefined();
      expect(plans[1].exclude).toEqual(["qwen3.5:9b"]);
      const [run] = m.history(bot.id);
      expect(run.note).toBe("Auto → network best fit (qwen3.5:9b answered with a plan and no tool calls)");
    } finally {
      await m.shutdown();
    }
  });

  it("the first route's note names the skipped model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bots-tools-"));
    const runner: BotRunner = async (ctx) => {
      const chat = botComputeChat(ctx, (_p, _plan, onRoute) => async function* () {
        onRoute({ placement: "network", model: "auto", computeClass: "any", cSatsPerSecond: 0, bestFit: true, reason: "network · best fit", why: "tools needed; local deepseek-r1:14b has no tool support" });
        yield { done: true };
      });
      await chat({ messages: [{ role: "user", content: "do it" }] });
    };
    const m = new BotManager({ runner, file: join(dir, "bots.json") });
    try {
      const bot = m.create({ name: "Harry", projectRoot: dir });
      m.runNow(bot.id);
      await m.idle(bot.id);
      expect(m.history(bot.id)[0].note).toBe("Auto → network best fit (tools needed; local deepseek-r1:14b has no tool support)");
    } finally {
      await m.shutdown();
    }
  });
});
