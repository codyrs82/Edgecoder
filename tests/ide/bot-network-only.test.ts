import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { BotManager, botComputeChat, registerBotRoutes, type BotRunner } from "../../src/apps/ide/bots.js";
import { IDE_CORS_METHODS, createIdeAuthHook, registerIdeCors } from "../../src/apps/ide/ide-auth.js";
import { DEFAULT_QUALITY_FLOOR, noRouteMessage, planRoutes, routeLabel, sizeWorkload, type PlanOptions, type RouteInputs } from "../../src/inference-api/auto-route.js";
import { autoBackend } from "../../src/inference-api/backends.js";
import { cleanHints, routingHintsFrom, type RoutingHints } from "../../src/inference-api/job-descriptor.js";
import { ChatBackendError, type ChatBackend, type ChatPiece } from "../../src/inference-api/types.js";

const dir = () => mkdtempSync(join(tmpdir(), "bots-net-"));
let managers: BotManager[] = [];
afterEach(async () => {
  for (const m of managers) await m.shutdown();
  managers = [];
});
const idle: BotRunner = async () => undefined;
function manager(runner: BotRunner = idle) {
  const m = new BotManager({ runner, file: join(dir(), "bots.json") });
  managers.push(m);
  return m;
}

const TOKEN = "test-ide-token-0123456789abcdef";
const ORIGIN = "tauri://localhost";

/** The provider's auth hook and CORS, in front of the bot routes, as provider-server.ts wires them. */
async function providerApp(m: BotManager) {
  const app = Fastify();
  const origins = new Set([ORIGIN]);
  app.addHook("onRequest", createIdeAuthHook({ token: TOKEN, port: 4304, enforceLoopbackHost: true, allowedOrigins: origins }));
  await registerIdeCors(app, origins);
  registerBotRoutes(app, m);
  return app;
}

/** What the bot settings dialog sent for Harry (desktop 1.4.49): Specific model on the network, budget 100, every permission on. */
const HARRY_SAVE = {
  name: "Harry",
  role: "Engineer",
  instructions: "",
  repository: "",
  triggers: [],
  maxTriggerRunsPerHour: 6,
  schedule: "",
  heartbeatMinutes: 30,
  maxRunsPerDay: 48,
  budgetCSatsPerDay: 100,
  allowedTools: ["read_file", "list_directory", "search_files", "search_codebase", "git_status", "git_diff", "git_log", "git_fetch", "github_list_prs", "github_list_issues", "write_file", "edit_file", "run_shell", "git_commit", "git_push", "open_pull_request"],
  autoApproveEdits: true,
  compute: { policy: "model", model: "network/qwen3-coder:30b" },
  color: "#0090ff",
  avatarShape: "robot",
  memory: "",
};

describe("saving a bot's settings from the desktop app (the 'couldn't reach' save)", () => {
  it("the CORS preflight allows PATCH and DELETE (it allowed only GET and POST, so WebKit failed the save with 'Load failed')", async () => {
    const m = manager();
    const app = await providerApp(m);
    for (const method of ["PATCH", "DELETE"]) {
      const pre = await app.inject({
        method: "OPTIONS",
        url: "/v1/ide/bots/bot_x",
        headers: { host: "127.0.0.1:4304", origin: ORIGIN, "access-control-request-method": method, "access-control-request-headers": "authorization,content-type" },
      });
      expect(pre.statusCode).toBe(204);
      expect(pre.headers["access-control-allow-origin"]).toBe(ORIGIN);
      expect(String(pre.headers["access-control-allow-methods"]).split(/,\s*/)).toContain(method);
    }
    expect(IDE_CORS_METHODS).toEqual(expect.arrayContaining(["GET", "POST", "PATCH", "DELETE"]));
    await app.close();
  });

  it("the dialog's exact save for Harry (Specific model network/qwen3-coder:30b, budget 100, permissions on) is accepted", async () => {
    const m = manager();
    const app = await providerApp(m);
    const bot = m.create({ name: "Harry", projectRoot: dir() });
    const headers = { host: "127.0.0.1:4304", origin: ORIGIN, authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const res = await app.inject({ method: "PATCH", url: `/v1/ide/bots/${bot.id}`, headers, payload: { ...HARRY_SAVE, projectRoot: bot.projectRoot } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.json().bot).toMatchObject({ compute: { policy: "model", model: "network/qwen3-coder:30b" }, budgetCSatsPerDay: 100, autoApproveEdits: true });
    // And the new Network GPU only, best fit.
    const net = await app.inject({ method: "PATCH", url: `/v1/ide/bots/${bot.id}`, headers, payload: { compute: { policy: "network_only", computeClass: "gpu" } } });
    expect(net.statusCode).toBe(200);
    expect(net.json().bot.compute).toEqual({ policy: "network_only", computeClass: "gpu" });
    await app.close();
  });

  it("a bad value comes back as a 400 with the server's message (shown as is, not as 'couldn't reach')", async () => {
    const m = manager();
    const app = await providerApp(m);
    const bot = m.create({ name: "Harry", projectRoot: dir() });
    const headers = { host: "127.0.0.1:4304", origin: ORIGIN, authorization: `Bearer ${TOKEN}` };
    const res = await app.inject({ method: "PATCH", url: `/v1/ide/bots/${bot.id}`, headers, payload: { compute: { policy: "network_only", computeClass: "tpu" } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^compute\.computeClass: /);
    await app.close();
  });
});

describe("Network only: the bot config", () => {
  it("keeps the class and an optional network model; other policies drop them", () => {
    const m = manager();
    const b = m.create({ name: "N", projectRoot: dir(), compute: { policy: "network_only", computeClass: "gpu.dc", model: " network/qwen3-coder:30b " } });
    expect(b.compute).toEqual({ policy: "network_only", computeClass: "gpu.dc", model: "network/qwen3-coder:30b" });
    expect(m.update(b.id, { compute: { policy: "network_only" } }).compute).toEqual({ policy: "network_only" });
    expect(m.update(b.id, { compute: { policy: "mine_only", computeClass: "gpu" } }).compute).toEqual({ policy: "mine_only" });
    expect(() => m.create({ name: "X", projectRoot: dir(), compute: { policy: "network_only", computeClass: "tpu" as never } })).toThrow(/Unknown compute class/);
  });
});

const heavy = sizeWorkload({ messages: [{ role: "user", content: "fix the bug" }], tools: [{ type: "function", function: { name: "edit_file" } }] }, DEFAULT_QUALITY_FLOOR);
const prices = { cpu: 0.009, apple: 0.052, gpu: 0.043, "gpu.dc": 0.304 };
const price = { input: 100, output: 400 };
/** A Mac with a capable local model, another machine of yours, a reservation, and the network on every class. */
const rich: RouteInputs = {
  localModels: ["qwen2.5-coder:14b"],
  myModels: ["qwen3-coder:30b"],
  leases: [{ id: "r1", computeClass: "gpu", models: ["qwen3-coder:30b"] }],
  networkModels: [
    { model: "qwen3-coder:30b", classes: ["gpu", "apple", "cpu", "gpu.dc"], cSatsPerMTokens: price },
    { model: "qwen2.5-coder:14b", classes: ["apple"], cSatsPerMTokens: price },
  ],
  classPrice: prices,
  balanceCSats: 500,
};
const where = (rs: ReturnType<typeof planRoutes>) => rs.map((r) => `${r.placement}:${r.computeClass ?? ""}:${r.model}${r.fallback ? ":fallback" : ""}`);

describe("Network only: routing", () => {
  it("never this computer, your machines or a reservation, and no free fallback", () => {
    const rs = planRoutes(heavy, rich, "network_only", { allowanceCSats: 100 });
    expect(rs.length).toBeGreaterThan(0);
    expect(rs.every((r) => r.placement === "network" && !r.fallback)).toBe(true);
    // Fastest class first; CPU is left out of agent work unless asked for.
    expect(where(rs)[0]).toBe("network:gpu.dc:qwen3-coder:30b");
    expect(rs.some((r) => r.computeClass === "cpu")).toBe(false);
  });

  it("each class choice keeps to its class (CPU too, when asked for)", () => {
    for (const cls of ["gpu", "apple", "cpu", "gpu.dc"]) {
      const rs = planRoutes(heavy, rich, "network_only", { allowanceCSats: 100, computeClass: cls });
      expect(rs.length).toBe(1);
      expect(rs[0]).toMatchObject({ placement: "network", computeClass: cls });
    }
    // A class nobody on the network has: nothing, not a local model.
    expect(planRoutes(heavy, { ...rich, networkModels: [{ model: "qwen3-coder:30b", classes: ["gpu"], cSatsPerMTokens: price }] }, "network_only", { computeClass: "apple" })).toEqual([]);
  });

  it("with the Model selector set, that model on the network (in the chosen class)", () => {
    expect(where(planRoutes(heavy, rich, "network_only", { model: "network/qwen3-coder:30b" }))).toEqual(["network:any:qwen3-coder:30b"]);
    expect(where(planRoutes(heavy, rich, "network_only", { model: "network/qwen3-coder:30b@apple", computeClass: "gpu" }))).toEqual(["network:gpu:qwen3-coder:30b"]);
    // A local pick still runs on the network, never here.
    expect(where(planRoutes(heavy, rich, "network_only", { model: "mine/qwen3-coder:30b", computeClass: "cpu" }))).toEqual(["network:cpu:qwen3-coder:30b"]);
  });

  it("budget or balance at 0: no route at all, and a clear message", () => {
    const opts: PlanOptions = { allowanceCSats: 0, budgetCSats: 100 };
    expect(planRoutes(heavy, rich, "network_only", opts)).toEqual([]);
    expect(planRoutes(heavy, { ...rich, balanceCSats: 0 }, "network_only", { computeClass: "gpu" })).toEqual([]);
    expect(noRouteMessage("network_only", rich, opts)).toMatch(/^Network only: no cSats left today \(budget 100\)/);
    expect(noRouteMessage("network_only", rich, { ...opts, computeClass: "gpu" })).toMatch(/^Network GPU only: no cSats left today \(budget 100\)/);
    expect(noRouteMessage("network_only", { ...rich, balanceCSats: 0 }, {})).toMatch(/^Network only: no cSats left \(balance 0\)/);
  });

  it("Local first and My machines only keep their meaning", () => {
    expect(where(planRoutes(heavy, rich, "local_first", { allowanceCSats: 100 }))[0]).toBe("local::qwen2.5-coder:14b");
    expect(planRoutes(heavy, rich, "mine_only").every((r) => r.placement === "local" || r.placement === "mine")).toBe(true);
  });

  it("labels the class on the best-fit leg", () => {
    expect(routeLabel({ placement: "network", model: "auto", computeClass: "gpu", cSatsPerSecond: 0, reason: "", bestFit: true })).toBe("Network GPU · best fit");
    expect(routeLabel({ placement: "network", model: "auto", computeClass: "any", cSatsPerSecond: 0, reason: "", bestFit: true })).toBe("Network · best fit");
  });
});

describe("Network only: the routed backend", () => {
  const collect = async (b: ChatBackend) => {
    const out: ChatPiece[] = [];
    for await (const p of b({ messages: [{ role: "user", content: "fix the bug" }], tools: [{ type: "function", function: { name: "edit_file" } }] })) out.push(p);
    return out;
  };

  it("asks the coordinator's best fit first, with the class as a hint; never runs locally when the network fails", async () => {
    const hints: RoutingHints[] = [];
    const tried: string[] = [];
    const b = autoBackend({
      inputs: async () => rich,
      policy: "network_only",
      plan: () => ({ allowanceCSats: 50, computeClass: "apple" }),
      run: (r) =>
        async function* () {
          tried.push(`${r.placement}:${r.computeClass}`);
          throw new ChatBackendError("Not enough cSats for this request.", 402);
        },
      networkBestFit: (routing) =>
        async function* () {
          hints.push(routing);
          tried.push("bestfit");
          throw new ChatBackendError("No apple machine is free.", 503);
        },
    });
    await expect(collect(b)).rejects.toThrow("Not enough cSats for this request.");
    expect(tried).toEqual(["bestfit", "network:apple"]);
    expect(hints[0]).toMatchObject({ computeClass: "apple", maxCSats: 50 });
  });

  it("best fit still leads when this side doesn't know the network's models", async () => {
    const tried: string[] = [];
    const b = autoBackend({
      inputs: async () => ({ ...rich, networkModels: [] }),
      policy: "network_only",
      plan: () => ({ allowanceCSats: 50 }),
      run: (r) =>
        async function* () {
          tried.push(r.placement);
        },
      networkBestFit: () =>
        async function* () {
          tried.push("bestfit");
          yield { delta: "ok" };
          yield { done: true, cSatsSpent: 1, where: "routed to qwen3-coder:30b on gpu" };
        },
    });
    const out = await collect(b);
    expect(tried).toEqual(["bestfit"]);
    expect(out[1]).toMatchObject({ done: true, where: "routed to qwen3-coder:30b on gpu" });
  });

  it("budget spent: stops with the message, nothing runs (the local model is never tried)", async () => {
    const tried: string[] = [];
    const b = autoBackend({
      inputs: async () => rich,
      policy: "network_only",
      plan: () => ({ allowanceCSats: 0, budgetCSats: 100 }),
      run: (r) =>
        async function* () {
          tried.push(r.placement);
        },
      networkBestFit: () =>
        async function* () {
          tried.push("bestfit");
        },
    });
    await expect(collect(b)).rejects.toThrow(/^Network only: no cSats left today \(budget 100\)/);
    expect(tried).toEqual([]);
  });
});

describe("Network only: a bot's model calls", () => {
  it("pass the class, the budget and the chosen model to the plan", async () => {
    const seen: PlanOptions[] = [];
    const runner: BotRunner = async (ctx) => {
      const chat = botComputeChat(ctx, (policy, plan, onRoute) => async function* () {
        expect(policy).toBe("network_only");
        seen.push(plan());
        onRoute({ placement: "network", model: "auto", computeClass: "gpu", cSatsPerSecond: 0, reason: "network gpu only · best fit", bestFit: true });
        yield { delta: "ok" };
        yield { done: true, cSatsSpent: 2 };
      });
      await chat({ messages: [{ role: "user", content: "go" }] });
    };
    const m = manager(runner);
    const bot = m.create({ name: "Harry", projectRoot: dir(), budgetCSatsPerDay: 100, compute: { policy: "network_only", computeClass: "gpu" } });
    m.runNow(bot.id);
    await m.idle(bot.id);
    expect(seen[0]).toMatchObject({ allowanceCSats: 100, budgetCSats: 100, computeClass: "gpu" });
    expect(seen[0].model).toBeUndefined();
    expect(m.history(bot.id)[0]).toMatchObject({ status: "done", where: "Network GPU · best fit" });
  });
});

describe("best-fit hints: the compute class", () => {
  it("reads it from the body or the x-edgecoder-compute-class header; unknown classes are dropped", () => {
    expect(cleanHints({ computeClass: "gpu" })).toEqual({ computeClass: "gpu" });
    expect(cleanHints({ compute_class: "GPU_DC" })).toEqual({ computeClass: "gpu.dc" });
    expect(cleanHints({ computeClass: "tpu" })).toEqual({});
    expect(routingHintsFrom({}, { "x-edgecoder-compute-class": "apple" })).toEqual({ computeClass: "apple" });
  });
});
