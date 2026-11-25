import { afterEach, describe, expect, it } from "vitest";
import { CloudHost, DEFAULT_REASONING_ALLOWANCE, PROVIDER_ACCOUNT_ALERT_EVERY_MS, cloudHostConfigFromEnv, parseReasoningAllowance, providerAccountAlert, providerAccountProblem, spendAlert, type CloudHostConfig, type CloudHostEvent } from "../../src/cloud-host/host.js";
import { CloudApiError } from "../../src/cloud-host/backend.js";
import { cloudHostEnv } from "../../src/cloud-host/main.js";
import { classifyHardware } from "../../src/economy/compute-classes.js";
import type { SpendEvent, SpendState } from "../../src/cloud-host/spend-guard.js";
import type { OllamaPiece } from "../../src/inference-api/ollama.js";
import { startFakeProvider, streamReply, type FakeProvider } from "./fake-provider.js";

/*
 * The cloud host: what it advertises and claims, how a call runs and is counted against the spend
 * guard, and how a refused key or a cap pauses it ("cloud_capacity_paused").
 */

const KEY = "fw-secret-key-abcdef0123456789";
let fake: FakeProvider | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

function host(url: string, opts: { guard?: Partial<CloudHostConfig["guard"]>; events?: CloudHostEvent[]; store?: { s?: SpendState } } = {}) {
  const cfg = cloudHostConfigFromEnv({ CLOUD_HOST_API_KEY: KEY, CLOUD_HOST_BASE_URL: url, CLOUD_HOST_MAX_RETRIES: 0 });
  cfg.guard = { ...cfg.guard, ...opts.guard };
  const store = opts.store ?? {};
  return new CloudHost(cfg, { notify: (e) => opts.events?.push(e), store: { load: () => store.s, save: (s) => (store.s = structuredClone(s)) }, backend: { sleep: async () => undefined } });
}

async function run(h: CloudHost, model: string, maxTokens = 50): Promise<OllamaPiece[]> {
  const out: OllamaPiece[] = [];
  for await (const p of h.chat(model, { messages: [{ role: "user", content: "write a haiku" }], maxTokens }, new AbortController().signal, 10_000)) out.push(p);
  return out;
}

describe("cloud host configuration", () => {
  it("defaults to Fireworks and every Fireworks catalog model, with the spend caps' defaults", () => {
    const cfg = cloudHostConfigFromEnv({ CLOUD_HOST_API_KEY: KEY });
    expect(cfg).toMatchObject({ provider: "fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", models: ["glm-5.3", "deepseek-v4.1-flash"], maxSlots: 16, guard: { dailyCapUsd: 200, monthlyCapUsd: 2_000, alertAtPct: 0.8, authFailureLimit: 3 } });
  });

  it("needs the key, known models and a well-formed model map", () => {
    expect(() => cloudHostConfigFromEnv({})).toThrow(/CLOUD_HOST_API_KEY is required/);
    expect(() => cloudHostConfigFromEnv({ CLOUD_HOST_API_KEY: KEY, CLOUD_HOST_MODELS: "glm-5.3,gpt-9" })).toThrow(/gpt-9 is not a Fireworks model/);
    expect(cloudHostConfigFromEnv({ CLOUD_HOST_API_KEY: KEY, CLOUD_HOST_MODELS: "deepseek-v4.1-flash" }).models).toEqual(["deepseek-v4.1-flash"]);
    expect(cloudHostConfigFromEnv({ CLOUD_HOST_API_KEY: KEY, CLOUD_HOST_MODEL_MAP: "glm-5.3=accounts/fireworks/models/glm-5p3-0818" }).modelMap).toEqual({ "glm-5.3": "accounts/fireworks/models/glm-5p3-0818" });
    expect(() => cloudHostConfigFromEnv({ CLOUD_HOST_API_KEY: KEY, CLOUD_HOST_MODEL_MAP: "nope" })).toThrow(/CLOUD_HOST_MODEL_MAP/);
  });

  it("the cloud-host role fills in an inference-only agent on the cloud engine", () => {
    const env = cloudHostEnv({ CLOUD_HOST_API_KEY: KEY, AGENT_BENCHMARK: "1" });
    expect(env).toMatchObject({ EDGECODER_ENGINE: "cloud", SANDBOX_MODE: "none", AGENT_INFERENCE_ONLY: "1", LOCAL_MODEL_PROVIDER: "ollama-local", AGENT_BENCHMARK: "1" });
    expect(cloudHostEnv({ EDGECODER_ENGINE: "vllm" }).EDGECODER_ENGINE).toBe("cloud");
  });
});

describe("what a cloud host advertises", () => {
  it("the enabled cloud model ids, a 1M window, and a hardware claim the coordinator classifies as the cloud class", () => {
    const h = host("http://127.0.0.1:9/v1");
    expect(h.advertisedModels()).toEqual(["glm-5.3", "deepseek-v4.1-flash"]);
    expect(h.contextWindow()).toBe(1_000_000);
    const profile = h.hardwareProfile();
    expect(profile.cloud).toEqual({ provider: "fireworks" });
    expect(classifyHardware(profile as never)).toMatchObject({ computeClass: "cloud", tier: "cloud", creditsPerSecond: 1 });
  });
});

describe("a call on the cloud host", () => {
  it("is forwarded under the provider's model id and counted at the provider's price", async () => {
    fake = await startFakeProvider([streamReply({ text: ["old pond"], usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000, cached: 500_000 } })]);
    const h = host(fake.url);
    const pieces = await run(h, "glm-5.3");
    expect(pieces.at(-1)).toMatchObject({ promptTokens: 1_000_000, outputTokens: 100_000, cachedPromptTokens: 500_000 });
    expect(fake.requests[0].body.model).toBe("accounts/fireworks/models/glm-5p3");
    // 500k × 1.40 + 500k × 0.26 + 100k × 4.40, per million: 0.70 + 0.13 + 0.44
    expect(h.guard.status().dayUsd).toBeCloseTo(1.27, 9);
  });

  it("a reply cut off before the counts is still counted (estimated from the text)", async () => {
    fake = await startFakeProvider([{ stream: [{ choices: [{ index: 0, delta: { content: "x".repeat(300) } }] }, { error: { message: "reset" } }] }]);
    const h = host(fake.url);
    // max_tokens well above the 300 characters, so the answer cap does not end it first.
    await expect(run(h, "deepseek-v4.1-flash", 1_000)).rejects.toThrow(/reset/);
    expect(h.guard.status().dayUsd).toBeGreaterThan(0);
  });

  it("a reasoning-only reply fails as reasoning_only and still counts what the provider billed", async () => {
    fake = await startFakeProvider([
      { stream: [{ choices: [{ index: 0, delta: { reasoning_content: "thinking" }, finish_reason: "length" }] }, { choices: [], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }, "[DONE]"] }
    ]);
    const h = host(fake.url);
    await expect(run(h, "deepseek-v4.1-flash", 16)).rejects.toThrow(/^reasoning_only: /);
    // Asked with the reasoning allowance, then once more with twice it.
    expect(fake.requests.map((r) => r.body.max_tokens)).toEqual([16 + 4_096, 16 + 8_192]);
    // Both attempts billed by the provider, both counted: 2 × (1M × 0.30 + 1M × 1.20), per million.
    expect(h.guard.status().dayUsd).toBeCloseTo(3, 9);
  });

  it("run 4: a reasoning model is asked for max_tokens plus its allowance, and the answer is capped at max_tokens", async () => {
    const reasoning = Array.from({ length: 50 }, () => ({ choices: [{ index: 0, delta: { reasoning_content: "hm " } }] }));
    const answer = Array.from({ length: 40 }, (_, i) => ({ choices: [{ index: 0, delta: { content: `w${i} ` } }] }));
    fake = await startFakeProvider([{ stream: [...reasoning, ...answer, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 90 } }, "[DONE]"] }]);
    const h = host(fake.url);
    const pieces = await run(h, "deepseek-v4.1-flash", 16);
    expect(fake.requests[0].body.max_tokens).toBe(16 + DEFAULT_REASONING_ALLOWANCE["deepseek-v4.1-flash"]);
    const text = pieces.filter((p) => "delta" in p);
    expect(text).toHaveLength(16);
    // Cut at the caller's cap: "length", and the provider's counts never came, so the streamed tokens are estimated.
    expect(pieces.at(-1)).toMatchObject({ doneReason: "length", outputTokens: 50 + 16 });
    expect(h.guard.status().dayUsd).toBeGreaterThan(0);
  });

  it("run 4: a reasoning-only reply is asked once more with twice the allowance; the answer then goes through", async () => {
    fake = await startFakeProvider([
      { stream: [{ choices: [{ index: 0, delta: { reasoning_content: "thinking" }, finish_reason: "length" }] }, { choices: [], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }, "[DONE]"] },
      { stream: [{ choices: [{ index: 0, delta: { reasoning_content: "more" } }] }, { choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }, "[DONE]"] }
    ]);
    const h = host(fake.url);
    const pieces = await run(h, "glm-5.3", 2_048);
    expect(fake.requests.map((r) => r.body.max_tokens)).toEqual([2_048 + 2_048, 2_048 + 4_096]);
    expect(pieces.filter((p) => "delta" in p).map((p) => (p as { delta: string }).delta).join("")).toBe("done");
    // The coordinator gets the answered attempt's counts; the first attempt is the platform's cost (spend guard).
    expect(pieces.at(-1)).toMatchObject({ doneReason: "stop", promptTokens: 1_000_000, outputTokens: 1_000_000 });
    // 2 × (1M × 1.40 + 1M × 4.40), per million
    expect(h.guard.status().dayUsd).toBeCloseTo(11.6, 9);
  });

  it("a call without max_tokens, or a model without an allowance, is sent as is", async () => {
    fake = await startFakeProvider([streamReply({ text: ["ok"], usage: { prompt_tokens: 1, completion_tokens: 1 } })]);
    const out: OllamaPiece[] = [];
    for await (const p of host(fake.url).chat("glm-5.3", { messages: [{ role: "user", content: "hi" }] }, new AbortController().signal, 10_000)) out.push(p);
    expect(fake.requests[0].body).not.toHaveProperty("max_tokens");
    const cfg = cloudHostConfigFromEnv({ CLOUD_HOST_API_KEY: KEY, CLOUD_HOST_BASE_URL: fake.url, CLOUD_HOST_MAX_RETRIES: 0, CLOUD_HOST_REASONING_ALLOWANCE: "off" });
    await run(new CloudHost(cfg, { store: { load: () => undefined, save: () => undefined } }), "glm-5.3", 50);
    expect(fake.requests[1].body.max_tokens).toBe(50);
  });

  it("CLOUD_HOST_REASONING_ALLOWANCE: defaults, a number, model pairs, off", () => {
    const models = ["glm-5.3", "deepseek-v4.1-flash"];
    expect(parseReasoningAllowance(undefined, models)).toEqual({ "deepseek-v4.1-flash": 4_096, "glm-5.3": 2_048 });
    expect(parseReasoningAllowance("8192", models)).toEqual({ "glm-5.3": 8_192, "deepseek-v4.1-flash": 8_192 });
    expect(parseReasoningAllowance("glm-5.3=0, deepseek-v4.1-flash=6000", models)).toEqual({ "deepseek-v4.1-flash": 6_000 });
    expect(parseReasoningAllowance("off", models)).toEqual({});
    expect(parseReasoningAllowance("0", models)).toEqual({});
    expect(() => parseReasoningAllowance("lots", models)).toThrow(/CLOUD_HOST_REASONING_ALLOWANCE/);
    expect(() => cloudHostConfigFromEnv({ CLOUD_HOST_API_KEY: KEY, CLOUD_HOST_REASONING_ALLOWANCE: "glm-5.3=-1" })).toThrow(/CLOUD_HOST_REASONING_ALLOWANCE/);
  });

  it("CLOUD_HOST_REASONING_EFFORT is sent as reasoning_effort", async () => {
    fake = await startFakeProvider([streamReply({ text: ["ok"], usage: { prompt_tokens: 1, completion_tokens: 1 } })]);
    const cfg = cloudHostConfigFromEnv({ CLOUD_HOST_API_KEY: KEY, CLOUD_HOST_BASE_URL: fake.url, CLOUD_HOST_MAX_RETRIES: 0, CLOUD_HOST_REASONING_EFFORT: "None" });
    expect(cfg.reasoningEffort).toBe("none");
    await run(new CloudHost(cfg, { store: { load: () => undefined, save: () => undefined } }), "glm-5.3");
    expect(fake.requests[0].body.reasoning_effort).toBe("none");
    expect(() => cloudHostConfigFromEnv({ CLOUD_HOST_API_KEY: KEY, CLOUD_HOST_REASONING_EFFORT: "low; drop" })).toThrow(/CLOUD_HOST_REASONING_EFFORT/);
  });

  it("refuses a model it does not serve and a call longer than the model's window", async () => {
    const h = host("http://127.0.0.1:9/v1");
    await expect(run(h, "qwen3-coder:30b")).rejects.toThrow(/^model_unavailable/);
    await expect(run(h, "glm-5.3", 2_000_000)).rejects.toMatchObject({ contextOverflow: true });
  });

  it("three refused keys pause it with an alert; it advertises nothing and refuses calls until the key works", async () => {
    fake = await startFakeProvider([{ status: 401, body: { error: { message: "bad key" } } }, { status: 401, body: {} }, { status: 401, body: {} }, { status: 200, body: { data: [] } }]);
    const events: SpendEvent[] = [];
    const h = host(fake.url, { events });
    for (let i = 0; i < 3; i++) await expect(run(h, "glm-5.3")).rejects.toThrow(/^cloud_provider_auth/);
    expect(events).toEqual([{ kind: "paused", reason: "auth", failures: 3 }]);
    expect(h.ready()).toBe(false);
    expect(h.advertisedModels()).toEqual([]);
    expect(h.advertisedChanged()).toBe(true);
    await expect(run(h, "glm-5.3")).rejects.toThrow(/^cloud_capacity_paused/);
    expect(fake.requests).toHaveLength(3); // the paused call never reached the provider
    await h.maybeProbeKey(Date.now()); // GET /models answers 200
    expect(h.ready()).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "resumed", reason: "auth" });
    expect(h.advertisedModels()).toEqual(["glm-5.3", "deepseek-v4.1-flash"]);
  });

  it("at the daily cap it pauses (alert at 80 %, then 100 %) and refuses with cloud_capacity_paused", async () => {
    // 1M prompt + 1M out on DeepSeek = 1.50 USD per call against a 2 USD cap.
    fake = await startFakeProvider([streamReply({ text: ["a"], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } })]);
    const events: SpendEvent[] = [];
    const h = host(fake.url, { events, guard: { dailyCapUsd: 2 } });
    await run(h, "deepseek-v4.1-flash");
    expect(events).toEqual([]);
    await run(h, "deepseek-v4.1-flash"); // 3.00 USD: past 80 % and 100 %
    expect(events.map((e) => e.kind)).toEqual(["warn", "paused"]);
    expect(h.advertisedModels()).toEqual([]);
    await expect(run(h, "deepseek-v4.1-flash")).rejects.toThrow(/^cloud_capacity_paused: the daily cloud spend cap is reached; resumes at /);
  });
});

describe("provider account problems (HTTP 412 suspended, 402, spending limit)", () => {
  it("alert once per hour through the notifier, without pausing the host", async () => {
    fake = await startFakeProvider([{ status: 412, body: { error: { message: "Account suspended" } } }]);
    const cfg = cloudHostConfigFromEnv({ CLOUD_HOST_API_KEY: KEY, CLOUD_HOST_BASE_URL: fake.url, CLOUD_HOST_MAX_RETRIES: 0 });
    let now = Date.UTC(2026, 10, 24, 3, 5);
    const events: CloudHostEvent[] = [];
    const store: { s?: SpendState } = {};
    const h = new CloudHost(cfg, { notify: (e) => events.push(e), now: () => now, store: { load: () => store.s, save: (s) => (store.s = structuredClone(s)) }, backend: { sleep: async () => undefined } });
    for (let i = 0; i < 3; i++) await expect(run(h, "glm-5.3")).rejects.toThrow(/^cloud_provider_error: Fireworks HTTP 412: Account suspended/);
    expect(events).toEqual([{ kind: "provider_account", status: 412, message: expect.stringContaining("Account suspended") }]);
    // Not a key problem: the host keeps advertising (the coordinator's breaker handles the failures).
    expect(h.ready()).toBe(true);
    now += PROVIDER_ACCOUNT_ALERT_EVERY_MS - 1;
    await expect(run(h, "glm-5.3")).rejects.toThrow(/412/);
    expect(events).toHaveLength(1);
    now += 1;
    await expect(run(h, "glm-5.3")).rejects.toThrow(/412/);
    expect(events).toHaveLength(2);
  });

  it("recognises 402 and spending-limit wording; ignores ordinary errors", () => {
    const err = (status: number, msg: string, kind: "auth" | "rate_limit" | "server" | "bad_request" = "bad_request") => new CloudApiError(`cloud_provider_error: Fireworks HTTP ${status}: ${msg}`, status, kind);
    expect(providerAccountProblem(err(412, "x"))).toMatchObject({ status: 412 });
    expect(providerAccountProblem(err(402, "Payment Required"))).toMatchObject({ status: 402 });
    expect(providerAccountProblem(err(429, "You have reached your spending limit", "rate_limit"))).toMatchObject({ status: 429 });
    expect(providerAccountProblem(err(403, "Your account has been suspended", "auth"))).toMatchObject({ status: 403 });
    expect(providerAccountProblem(err(429, "rate limited", "rate_limit"))).toBeNull();
    expect(providerAccountProblem(err(500, "internal", "server"))).toBeNull();
    expect(providerAccountProblem(err(400, "prompt too long"))).toBeNull();
    expect(providerAccountProblem(new Error("Account suspended"))).toBeNull();
  });

  it("the alert is critical, names the status and never carries the key", () => {
    const n = providerAccountAlert({ kind: "provider_account", status: 412, message: "cloud_provider_error: Fireworks HTTP 412: Account suspended" }, { agentId: "cloud-fw-1", provider: "Fireworks", reporter: "cloud host cloud-fw-1", portalUrl: "https://edgecoder.io", nowMs: 1 });
    expect(n.kind).toBe("firing");
    expect(n.alert).toMatchObject({ severity: "critical", rule: "cloud_provider_account", key: "cloud_host_provider_account:cloud-fw-1", title: "Cloud host cloud-fw-1: Fireworks refused a call for the account (HTTP 412)" });
    expect(n.alert.summary).toContain("suspended");
    expect(JSON.stringify(n)).not.toContain(KEY);
  });
});

describe("ops alerts", () => {
  it("say what happened and never carry the key", () => {
    const ctx = { agentId: "cloud-fw-1", provider: "Fireworks", reporter: "cloud host cloud-fw-1", portalUrl: "https://edgecoder.io", nowMs: 1 };
    const warn = spendAlert({ kind: "warn", scope: "day", spentUsd: 161.5, capUsd: 200 }, ctx);
    expect(warn.alert.title).toBe("Cloud host cloud-fw-1: daily Fireworks spend at 81 % of its cap");
    expect(warn.alert.severity).toBe("warning");
    const paused = spendAlert({ kind: "paused", reason: "monthly_cap", spentUsd: 2_001, capUsd: 2_000, resumesAtMs: Date.UTC(2026, 11, 1) }, ctx);
    expect(paused.alert).toMatchObject({ severity: "critical", title: "Cloud host cloud-fw-1 paused: monthly Fireworks spend cap reached" });
    expect(paused.alert.summary).toContain("2026-12-01T00:00:00.000Z");
    const auth = spendAlert({ kind: "paused", reason: "auth", failures: 3 }, ctx);
    expect(auth.alert.summary).toContain("CLOUD_HOST_API_KEY");
    const resumed = spendAlert({ kind: "resumed", reason: "auth" }, ctx);
    expect(resumed.kind).toBe("resolved");
    for (const n of [warn, paused, auth, resumed]) expect(JSON.stringify(n)).not.toContain(KEY);
  });
});
