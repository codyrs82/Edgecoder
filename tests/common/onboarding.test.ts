import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as O from "../../src/common/onboarding.js";
import { TOKEN_PRICE_USD_PER_M, cSatsPerMTokens } from "../../src/economy/job-pricing.js";
import { ONBOARDING_BROWSER_LIB } from "../../src/portal/pages/welcome.js";

const NOW = 1_800_000_000_000;
const SIGNALS: O.OnboardingSignals = {
  machines: 0,
  machinesOnline: 0,
  balanceCSats: 0,
  apiKeys: 0,
  github: false,
  firstTask: false,
  hostApproved: false,
  hostRequested: false,
  newAccount: true,
  localModels: 0,
  cliInstalled: false
};
const state = (over: Partial<O.OnboardingState> = {}): O.OnboardingState => ({ ...O.emptyOnboardingState(NOW), ...over });

describe("onboarding: one module for the desktop and the portal", () => {
  it("desktop/src/lib/onboarding.ts is byte-identical with src/common/onboarding.ts", () => {
    const shared = readFileSync(new URL("../../src/common/onboarding.ts", import.meta.url), "utf8");
    const desktop = readFileSync(new URL("../../desktop/src/lib/onboarding.ts", import.meta.url), "utf8");
    expect(desktop).toBe(shared);
  });

  it("the browser copy is self-contained and computes what the module does", () => {
    const lib = new Function(`${ONBOARDING_BROWSER_LIB}; return { progressFor, classPrice, cSatsPerCall, shouldShowOnboarding, suggestModel, stepFromRoute, installCommand };`)() as typeof O;
    const s = state({ goal: "both", done: ["welcome", "how"], current: "machines" });
    expect(lib.progressFor(s, SIGNALS, "web")).toEqual(O.progressFor(s, SIGNALS, "web"));
    const live = { models: [{ model: "qwen3-coder:30b", cSatsPerMTokens: { input: 322.7, output: 939.8 } }], btcUsd: 176_000 };
    for (const c of O.MODEL_CLASSES) expect(lib.classPrice(c.id, live)).toEqual(O.classPrice(c.id, live));
    expect(lib.shouldShowOnboarding(null, SIGNALS)).toBe(true);
    expect(lib.suggestModel({ ramGb: 16, computeClass: "cpu" })).toEqual(O.suggestModel({ ramGb: 16, computeClass: "cpu" }));
    expect(lib.stepFromRoute("/portal/welcome/fund")).toBe("fund");
    expect(lib.installCommand("https://edgecoder.io/", "T")).toBe(O.installCommand("https://edgecoder.io/", "T"));
  });

  it("the fallback prices are the coordinator's (src/economy/job-pricing.ts)", () => {
    expect(O.FALLBACK_TOKEN_PRICES.map((p) => ({ ...p, maxB: p.maxB >= 1e9 ? Infinity : p.maxB }))).toEqual(TOKEN_PRICE_USD_PER_M);
  });
});

describe("the step model", () => {
  it("has the ten steps in order, each with a title, short body and a video slot", () => {
    expect(O.ONBOARDING_STEPS.map((s) => s.id)).toEqual(O.STEP_IDS);
    expect(O.STEP_IDS).toEqual(["welcome", "how", "this-machine", "machines", "models", "fund", "tools", "try", "host", "done"]);
    for (const s of O.ONBOARDING_STEPS) {
      expect(s.title.length).toBeGreaterThan(3);
      expect(s.body.length).toBeLessThan(220);
      // Steps without an explainer yet keep the slot hidden.
      if (s.id !== "how") expect(s.video).toEqual({ src: null, poster: null, captions: null });
    }
  });

  it("each step's video, poster and captions are files the portal serves (/assets/videos/)", () => {
    const withVideo = O.ONBOARDING_STEPS.filter((s) => s.video.src);
    expect(withVideo.map((s) => s.id)).toEqual(["how"]);
    for (const s of withVideo) {
      for (const url of [s.video.src, s.video.poster, s.video.captions]) {
        expect(url).toMatch(/^\/assets\/videos\/[a-z0-9-]+\.(mp4|jpg|vtt)$/);
        expect(existsSync(fileURLToPath(new URL(`../../src/portal${url}`, import.meta.url))), url!).toBe(true);
      }
    }
  });

  it("tailors the steps to the goal: buying compute skips adding machines", () => {
    expect(O.stepsFor("buy").map((s) => s.id)).not.toContain("machines");
    expect(O.stepsFor("own").map((s) => s.id)).toContain("machines");
    expect(O.stepsFor(null)).toHaveLength(10);
    expect(O.nextStepId("models", "buy")).toBe("fund");
    expect(O.nextStepId("this-machine", "buy")).toBe("models");
    expect(O.prevStepId("models", "buy")).toBe("this-machine");
    expect(O.nextStepId("done", null)).toBeNull();
    expect(O.fundingOptional("own")).toBe(true);
    expect(O.fundingOptional("buy")).toBe(false);
  });

  it("uses the product's words: Buy cSats, Fund with Lightning, never invoice; hosting by request", () => {
    const text = JSON.stringify([O.ONBOARDING_STEPS, O.HOW_CARDS, O.HOW_MORE, O.GOAL_OPTIONS, O.ROUTING_OPTIONS]);
    expect(text).toContain("Buy cSats");
    expect(text.toLowerCase()).not.toContain("invoice");
    expect(text).toContain("by request");
    expect(text).toContain("95%");
    expect(O.ROUTING_OPTIONS.map((r) => r.title)).toEqual(["Auto", "Local first", "This computer only", "My machines only", "Specific model"]);
    expect(O.ROUTING_OPTIONS.filter((r) => r.recommended).map((r) => r.id)).toEqual(["auto"]);
  });

  it("has stable routes per step on both surfaces", () => {
    for (const id of O.STEP_IDS) {
      expect(O.stepFromRoute(O.stepRoute(id, "web"))).toBe(id);
      expect(O.stepFromRoute(O.stepRoute(id, "desktop"))).toBe(id);
    }
    expect(O.stepFromRoute("/portal/welcome/nope")).toBeNull();
    expect(O.actionHref("@mac")).toMatch(/^https:\/\/github\.com\/codyrs82\/Edgecoder\/releases\//);
    expect(O.actionHref("/host")).toBe("/host");
  });
});

describe("completion detection reads real state", () => {
  const s = state();
  it("machines, balance, keys, GitHub, CLI and the first task", () => {
    expect(O.itemDone("machine-linked", { ...SIGNALS, machines: 1 }, s)).toBe(true);
    expect(O.itemDone("second-machine", { ...SIGNALS, machines: 1 }, s)).toBe(false);
    expect(O.itemDone("second-machine", { ...SIGNALS, machines: 2 }, s)).toBe(true);
    expect(O.itemDone("funded", { ...SIGNALS, balanceCSats: 0 }, s)).toBe(false);
    expect(O.itemDone("funded", { ...SIGNALS, balanceCSats: 12.5 }, s)).toBe(true);
    expect(O.itemDone("funded", { ...SIGNALS, balanceCSats: null }, s)).toBeNull();
    expect(O.itemDone("api-key", { ...SIGNALS, apiKeys: 1 }, s)).toBe(true);
    expect(O.itemDone("github", { ...SIGNALS, github: true }, s)).toBe(true);
    expect(O.itemDone("cli", { ...SIGNALS, cliInstalled: null }, s)).toBeNull();
    expect(O.itemDone("first-task", SIGNALS, s)).toBe(false);
    expect(O.itemDone("first-task", SIGNALS, state({ firstTaskAtMs: NOW }))).toBe(true);
    expect(O.itemDone("host-requested", { ...SIGNALS, hostApproved: true, hostRequested: false }, s)).toBe(true);
  });

  it("a step is complete when its required items are; unknown items don't block; info steps need Next", () => {
    const fund = O.stepById("fund");
    expect(O.stepComplete(fund, SIGNALS, s, "web")).toBe(false);
    expect(O.stepComplete(fund, { ...SIGNALS, balanceCSats: 5 }, s, "web")).toBe(true);
    const tools = O.stepById("tools");
    expect(O.stepComplete(tools, SIGNALS, s, "web")).toBe(false);
    expect(O.stepComplete(tools, SIGNALS, state({ done: ["tools"] }), "web")).toBe(true);
    const machine = O.stepById("this-machine");
    // The web can't see this computer's models: only the account's machines count there.
    expect(O.stepComplete(machine, { ...SIGNALS, machines: 1, localModels: null }, s, "web")).toBe(true);
    expect(O.stepComplete(machine, { ...SIGNALS, machines: 1, localModels: 0 }, s, "desktop")).toBe(false);
    expect(O.checklistFor(machine, "web").map((c) => c.id)).toEqual(["machine-linked"]);
    const p = O.progressFor(state({ goal: "buy", current: "fund", done: ["welcome", "how"] }), { ...SIGNALS, balanceCSats: 10 }, "web");
    expect(p.total).toBe(9);
    expect(p.steps[p.index].id).toBe("fund");
    expect(p.completed).toBe(3); // welcome (goal chosen), how (moved past), fund (balance)
  });

  it("doesn't list checklist items the step's own choice answers, but still counts them", () => {
    const welcome = O.stepById("welcome");
    const models = O.stepById("models");
    expect(O.shownChecklist(welcome, "desktop")).toEqual([]);
    expect(O.shownChecklist(models, "web")).toEqual([]);
    expect(O.stepComplete(welcome, SIGNALS, state({ goal: null }), "web")).toBe(false);
    expect(O.stepComplete(welcome, SIGNALS, state({ goal: "own" }), "web")).toBe(true);
    // Items that read real state stay listed.
    expect(O.shownChecklist(O.stepById("fund"), "web").map((c) => c.id)).toEqual(["funded"]);
    expect(O.shownChecklist(O.stepById("this-machine"), "desktop").map((c) => c.id)).toEqual(["local-model", "machine-linked"]);
  });

  it("marks steps the person moved past (Next or Skip) as visited", () => {
    const p = O.progressFor(state({ goal: "both", current: "machines", done: ["welcome"], skipped: ["how"] }), { ...SIGNALS, balanceCSats: 10 }, "web");
    const by = (id: O.StepId) => p.steps.find((s) => s.id === id)!;
    expect(by("welcome").visited).toBe(true);
    expect(by("how").visited).toBe(true);
    // Fund is complete from the balance but not reached yet.
    expect(by("fund")).toMatchObject({ complete: true, visited: false });
    expect(by("machines").visited).toBe(false);
  });

  it("shows itself on first sign-in, resumes, and stays closed once dismissed or finished", () => {
    expect(O.shouldShowOnboarding(null, SIGNALS)).toBe(true);
    expect(O.shouldShowOnboarding(null, { ...SIGNALS, newAccount: false, machines: 2, balanceCSats: 100 })).toBe(false);
    expect(O.shouldShowOnboarding(null, { ...SIGNALS, newAccount: false, machines: 0, balanceCSats: 0 })).toBe(true);
    expect(O.shouldShowOnboarding(state({ firstSeenAtMs: NOW }), { ...SIGNALS, newAccount: false, machines: 3, balanceCSats: 9 })).toBe(true);
    expect(O.shouldShowOnboarding(state({ firstSeenAtMs: NOW, dismissed: true }), SIGNALS)).toBe(false);
    expect(O.shouldShowOnboarding(state({ firstSeenAtMs: NOW, completedAtMs: NOW }), SIGNALS)).toBe(false);
  });

  it("normalizes saved state, dropping unknown values", () => {
    const n = O.normalizeOnboardingState({ goal: "x", done: ["fund", "nope"], current: "zzz", routing: "auto", dismissed: "yes", completedAtMs: -1 }, NOW);
    expect(n).toMatchObject({ goal: null, done: ["fund"], current: "welcome", routing: "auto", dismissed: false, completedAtMs: null });
  });
});

describe("model suggestion and the cost estimator", () => {
  it("suggests by RAM and GPU: 7–9B on 16 GB, a 30B on a 32 GB+ Mac or a GPU", () => {
    expect(O.suggestModel({ ramGb: 16, computeClass: "apple" }).model).toBe("qwen3.5:9b");
    expect(O.suggestModel({ ramGb: 36, computeClass: "apple" }).model).toBe("qwen3-coder:30b");
    expect(O.suggestModel({ ramGb: 16, computeClass: "gpu" }).model).toBe("qwen3-coder:30b");
    expect(O.suggestModel({ ramGb: 64, computeClass: "cpu" }).model).toBe("qwen3.5:9b");
    expect(O.suggestModel({ ramGb: 8, computeClass: "cpu" }).model).toBe("qwen3.5:4b");
    expect(O.suggestModel({ ramGb: null, computeClass: null }).model).toBe("qwen3.5:2b");
  });

  it("prices a typical 30B call at about 2.8 cSats, from the coordinator's own price", () => {
    const btcUsd = 176_600;
    const live = { models: [{ model: "qwen3-coder:30b", cSatsPerMTokens: cSatsPerMTokens(30, btcUsd) }], btcUsd };
    const p = O.classPrice("35b", live)!;
    expect(p.source).toBe("network");
    const per = O.cSatsPerCall(p);
    expect(per).toBeGreaterThan(2.6);
    expect(per).toBeLessThan(3);
    expect(O.callsPerThousand(per)).toBeGreaterThan(330);
    // Without a listed model of the class, the reference price at the live rate.
    const ref = O.classPrice("9b", live)!;
    expect(ref.source).toBe("reference");
    expect(O.cSatsPerCall(ref)).toBeLessThan(per);
    expect(O.classPrice("9b", { models: [], btcUsd: null })).toBeNull();
    expect(O.estimateCSats(100, 2.8, 30)).toBe(8400);
    expect(O.groupThousands(1234567)).toBe("1,234,567");
    expect(O.paramsFromModel("qwen3-coder:30b")).toBe(30);
    expect(O.paramsFromModel("gemma4:e4b")).toBeNull();
  });
});
