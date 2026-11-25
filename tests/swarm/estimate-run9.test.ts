import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, grantCredits } from "../../src/credits/store.js";
import { SLOW_HOST_PREFILL_FACTOR } from "../../src/economy/job-pricing.js";

/*
 * Network validation run 9 (2026-11-25, scratchpad netval/run9/report.md, items 2 and 5):
 *
 * 2. Heavy-prompt calls (~4.5k-token prompt of numbered code, max_tokens 300) on the 2-core 1.5b CPU
 *    hosts ran to the 180 s timeout: inf-1795634348378-aae1b4b0 (iad, first token after 169 s) and
 *    inf-1795634340227-4d5c15c3 (jnb, nothing sent). Admission had counted the prompt at 4 bytes a
 *    token (~3.1k) and read it at decode × 6 (~39 tok/s): ~128 s, under the 162 s limit.
 * 5. Simple Auto chats with max_tokens 1024 (inf-1795634792979-904caf10, inf-1795634791108-926930fc)
 *    went to the cloud as overflow while the CPU hosts were idle: the completion check judged them
 *    on their max_tokens at ~6.5 tok/s.
 */

const MESH = "mesh-secret-run9";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.99";
const MODEL = "qwen2.5-coder:1.5b";
let portal: Server;
let app: any;
let eta: any;
let inference: any;
let expected: any;
const requester = createPeerKeys("agent-run9-requester");
const iad = createPeerKeys("agent-run9-iad");
const jnb = createPeerKeys("agent-run9-jnb");

beforeAll(async () => {
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const allowed = req.url === "/internal/nodes/validate" && body.registrationToken === VALID_TOKEN;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(allowed ? { allowed: true, reason: "portal_validated", node: {} } : { allowed: false, reason: "invalid_token" }));
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = MESH;
  process.env.COORDINATOR_STARTUP_GRACE_MS = "0";
  delete process.env.INFERENCE_COMPLETION_PRIOR_SPEED;
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  eta = await import("../../src/swarm/coordinator/start-eta.js");
  inference = await import("../../src/swarm/coordinator/routes/inference.js");
  expected = await import("../../src/swarm/coordinator/expected-output.js");
  await app.ready();
  await register(requester, []);
  await register(iad, [MODEL], "iad");
  await register(jnb, [MODEL], "jnb");
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  delete process.env.COORDINATOR_STARTUP_GRACE_MS;
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

async function register(keys: PeerKeys, installedModels: string[], region?: string) {
  const payload = JSON.stringify({
    os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem,
    sandboxMode: "docker", installedModels, ...(region ? { region } : {}),
  });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
  expect(res.statusCode, res.body).toBe(200);
}

function post(url: string, body: unknown, signer: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

const pullAs = async (k: PeerKeys, slots = 2, free = 2) => {
  const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: slots, freeInferenceSlots: free }, k)).json();
  return { id: (r.subtask?.id ?? r.envelope?.subtaskId ?? null) as string | null, taskId: (r.subtask?.taskId ?? r.envelope?.taskId ?? null) as string | null };
};
const finish = async (k: PeerKeys, taskId: string, subtaskId: string, outputTokens = 1) => {
  await post("/inference/chunks", { subtaskId, seq: 0, delta: "ok", done: true, promptTokens: 3, outputTokens }, k);
  await post("/result", { subtaskId, taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 100, model: MODEL }, k);
};
async function drain() {
  for (let i = 0; i < 64; i++) {
    let any = false;
    for (const k of [iad, jnb]) {
      const r = await pullAs(k);
      if (!r.id || !r.taskId) continue;
      any = true;
      await finish(k, r.taskId, r.id);
    }
    if (!any) break;
  }
}

/** The run-9 heavy prompt (run9/long-4.json): `lines` numbered one-line functions. */
const heavyModule = (lines: number, seed = 10_780) =>
  "Here is a module:\n" + Array.from({ length: lines }, (_, i) => `function z${seed}_${i}(a, b) { const r = a * ${seed + i} + b - ${(i * 5) % 13}; return r > ${i} ? r : b; }`).join("\n") + "\nSummarise what it does.";
const heavy = (lines = 150) => ({ model: MODEL, maxTokens: 300, messages: [{ role: "user", content: heavyModule(lines) }] });
const jsonOf = (b: { messages: unknown[] }) => JSON.stringify({ messages: b.messages, tools: [] });

const submit = async (body: Record<string, unknown>) => {
  const taskId = `inf-${randomUUID()}`;
  const t0 = Date.now();
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, timeoutMs: 180_000, ...body }, requester);
  return { taskId, r, ms: Date.now() - t0 };
};

beforeEach(async () => {
  await drain();
  await pullAs(iad);
  await pullAs(jnb);
  eta.serviceTimes.clear();
  eta.decodeRates.clear();
  eta.prefillRates.clear();
  eta.modelPickups.clear();
  expected.clearExpectedOutput();
});

describe("item 2: a long prompt's prefill is priced from its token count and the class's prefill rate", () => {
  test("prompt tokens: digits count one each (code full of numbers is ~45% denser than 4 bytes a token); prose is unchanged", () => {
    const text = jsonOf(heavy());
    const bytes = Buffer.byteLength(text, "utf8");
    expect(bytes / 4).toBeLessThan(3_300); // what admission counted in run 9 (~3.1k)
    expect(eta.promptTokenEstimate(text)).toBeGreaterThan(4_300); // the model read ~4.5k
    const prose = "The quick brown fox jumps over the lazy dog. ".repeat(40);
    expect(eta.promptTokenEstimate(prose)).toBe(Math.ceil(Buffer.byteLength(prose) / 4));
  });

  test("the run-9 call on a 1.5b CPU host: estimated past the 180 s timeout (was ~128 s), prefill alone over two minutes", () => {
    const text = jsonOf(heavy());
    const est = eta.decodeEstimateMs(MODEL, "cpu", eta.promptTokenEstimate(text), 300);
    expect(est.prior).toBe(true);
    expect(est.prefillTps).toBeLessThan(30); // ~27 tok/s measured on the 2-core hosts
    expect(est.prefillMs).toBeGreaterThan(120_000);
    expect(est.ms).toBeGreaterThan(180_000);
    // The old estimate: 4 bytes a token at decode × SLOW_HOST_PREFILL_FACTOR.
    const tps = eta.priorDecodeTps(MODEL, "cpu");
    const old = eta.DECODE_ESTIMATE_OVERHEAD_MS + ((Buffer.byteLength(text) / 4) / (tps * SLOW_HOST_PREFILL_FACTOR.cpu) + 300 / tps) * 1000;
    expect(old).toBeLessThan(162_000);
  });

  test("measured prefill: only samples of prompts at least half this one's size count; the prior fills the rest", () => {
    const prompt = 4_800;
    // Short prompts read fast (fixed overhead amortised, cached prefixes): they say little about 4.8k tokens.
    for (let i = 0; i < 5; i++) eta.prefillRates.record(MODEL, "cpu", 200, Date.now(), 400);
    const decode = eta.priorDecodeTps(MODEL, "cpu");
    // Run 10: the fallback is the lower of decode × COMPLETION_PREFILL_FACTOR and the class's prefill prior.
    expect(eta.completionPrefillTps(MODEL, "cpu", prompt, decode).tps).toBeCloseTo(Math.min(decode * eta.COMPLETION_PREFILL_FACTOR.cpu, eta.priorPrefillTps(MODEL, "cpu")), 5);
    // ...but they do count for a prompt of their own size.
    expect(eta.completionPrefillTps(MODEL, "cpu", 450, decode)).toMatchObject({ tps: 200, from: "measured" });
    // Long prompts measured on a faster (4-core) host take over.
    for (let i = 0; i < 3; i++) eta.prefillRates.record(MODEL, "cpu", 80, Date.now(), 4_500);
    expect(eta.completionPrefillTps(MODEL, "cpu", prompt, decode).tps).toBe(80);
  });

  test("a finished call's prefill sample keeps its prompt size", () => {
    const now = Date.now();
    eta.noteDecodeRate(MODEL, iad.peerId, now - 200_000, now - 30_000, now, { promptTokens: 4_500, outputTokens: 300 }, 1);
    expect(eta.prefillRates.rate(MODEL, "cpu", 1, now, 4_000)?.samples).toBe(1);
    expect(eta.prefillRates.rate(MODEL, "cpu", 1, now, 5_000)?.samples).toBe(0);
  });

  test("submit: the run-9 call is refused at once (nothing reserved) instead of timing out", async () => {
    const before = creditEngine.balance(requester.peerId);
    const { r, ms } = await submit(heavy());
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy", limitMs: 162_000 });
    expect(r.json().completionEtaMs).toBeGreaterThan(180_000);
    expect(ms).toBeLessThan(2_000);
    expect(creditEngine.balance(requester.peerId)).toBe(before);
  });

  test("submit: without max_tokens the heavy prompt is still judged on its prefill", async () => {
    const { r } = await submit({ model: MODEL, messages: heavy().messages });
    expect(r.statusCode, r.body).toBe(503);
  });

  test("submit: hosts measured reading long prompts fast (4-core) get the call", async () => {
    for (let i = 0; i < 3; i++) eta.prefillRates.record(MODEL, "cpu", 90, Date.now(), 4_500);
    const { r, taskId } = await submit(heavy());
    expect(r.statusCode, r.body).toBe(200);
    const pulled = await pullAs(iad);
    expect(pulled.id).toBe(r.json().subtaskId);
    await finish(iad, taskId, pulled.id!);
  });

  test("an estimate between the 162 s limit and the 180 s timeout on the class's token rates is not explored", () => {
    // Find a heavy prompt the rate prior puts between the limit and the timeout.
    let lines = 40;
    let ms = 0;
    for (; lines < 200; lines++) {
      ms = eta.decodeEstimateMs(MODEL, "cpu", eta.promptTokenEstimate(jsonOf(heavy(lines))), 300).ms;
      if (ms > 165_000) break;
    }
    expect(ms).toBeGreaterThan(162_000);
    expect(ms).toBeLessThan(180_000);
    const body = heavy(lines);
    const check = inference.completionCheck(MODEL, "cpu", body.messages, undefined, 300, 180_000, Date.now(), { waiting: 0 });
    expect(check.none).toBe(true);
  });
});

describe("item 5: an Auto call is judged on its expected reply, not its max_tokens", () => {
  const chat = (maxTokens: number) => ({ model: "auto", maxTokens, messages: [{ role: "user", content: `What is the capital of France? (${randomUUID().slice(0, 8)})` }] });

  test("expected output: observed median of the job type, else the descriptor's estimate; floored, capped by max_tokens", () => {
    expect(expected.expectedOutputTokens({ job: "chat", expectedOutputTokens: 240, maxTokens: 1_024 })).toBe(240);
    expect(expected.expectedOutputTokens({ job: "chat", expectedOutputTokens: 240, maxTokens: 100 })).toBe(100);
    expect(expected.expectedOutputTokens({ job: "chat", expectedOutputTokens: 3 })).toBe(expected.EXPECTED_OUTPUT_MIN_TOKENS);
    for (const n of [300, 500, 900]) expected.outputLengths.record("chat", n);
    expect(expected.expectedOutputTokens({ job: "chat", expectedOutputTokens: 240, maxTokens: 1_024 })).toBe(500);
    expect(expected.expectedOutputTokens({ job: "tests", expectedOutputTokens: 800, maxTokens: 1_024 })).toBe(800);
  });

  test("a finished Auto call's output is a sample for its job type; a cloud host's (reasoning counted as output) is not", () => {
    expected.noteJudgedOutput("st-cpu-1", "chat", 240);
    expected.noteJudgedOutput("st-cloud-1", "chat", 240);
    expected.noteFinishedOutput("st-cloud-1", 4_000, "cloud");
    for (const id of ["st-cpu-1", "st-cpu-2", "st-cpu-3"]) {
      expected.noteJudgedOutput(id, "chat", 240);
      expected.noteFinishedOutput(id, 120, "cpu");
    }
    expected.noteFinishedOutput("st-named", 9_999, "cpu"); // a named-model call: not a sample
    expect(expected.outputLengths.median("chat")).toBe(120);
    expect(expected.judgedOutputOf("st-cpu-1")).toBeUndefined();
  });

  test("simple chat, max_tokens 2000, idle 1.5b CPU hosts: placed on them (was refused / sent to the cloud), and claimed", async () => {
    // Judged on max_tokens, 2,000 tokens at ~6.5 tok/s is ~5 minutes: no CPU host would have been room.
    expect(eta.decodeEstimateMs(MODEL, "cpu", 40, 2_000).ms).toBeGreaterThan(180_000);
    const { r, taskId } = await submit(chat(2_000));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().model).toBe(MODEL);
    const subtaskId = r.json().subtaskId;
    expect(expected.judgedOutputOf(subtaskId)).toBeLessThan(600);
    // Claim-time admission judges it on the same expected reply, so the host's pull gets it.
    let ranOn: PeerKeys | null = null;
    for (let i = 0; i < 10 && !ranOn; i++) {
      for (const k of [iad, jnb]) {
        if (ranOn) break;
        if ((await pullAs(k)).id === subtaskId) ranOn = k;
      }
      if (!ranOn) await new Promise((res) => setTimeout(res, 200));
    }
    expect(ranOn).not.toBeNull();
    await finish(ranOn!, taskId, subtaskId, 180);
    expect(expected.judgedOutputOf(subtaskId)).toBeUndefined();
  });

  test("when recent chats really wrote long replies, the same call is judged on those (not sent where it cannot finish)", async () => {
    for (let i = 0; i < 3; i++) expected.outputLengths.record("chat", 1_500);
    const before = creditEngine.balance(requester.peerId);
    const { r } = await submit(chat(2_000));
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    expect(creditEngine.balance(requester.peerId)).toBe(before);
  });

  test("a named-model call keeps its max_tokens judgement (run 7)", async () => {
    const { r } = await submit({ ...chat(2_000), model: MODEL });
    expect(r.statusCode, r.body).toBe(503);
  });
});

/*
 * Network validation run 10 (scratchpad netval/run10/report.md, item 3): the same ~4.6k-token prompt
 * (max_tokens 300) was admitted on the 2-core 1.5b CPU hosts again: inf-1795642903097-65a0dde5 (jnb)
 * sent nothing in 180 s; lax, gru and iad took 125-144 s to the first token (26-37 tok/s reading the
 * prompt) and wrote the reply at ~7-10 tok/s. With no long prompt measured, the prefill rate was
 * decode × 4, and the decode rate measured on short calls was ~9-14 tok/s: ~150 s, under the 162 s limit.
 * (The "~44 s" in the routing line is the portal's coordinator-choice estimate, not admission.)
 */
describe("run 10: a long prompt's prefill is not derived from a fast short-call decode rate", () => {
  /** The run-10 long prompt (run10/lp-3.json, the jnb call: seed 3618, 150 functions, ~4.6k tokens). */
  const lpModule = (seed = 3_618, lines = 150) =>
    "Here is a module:\n" + Array.from({ length: lines }, (_, i) => `function y${seed}_${i}(a, b) { const r = a * ${seed + i} + b - ${(i * 5) % 13}; return r > ${i} ? r : b; }`).join("\n") + "\nSummarize what this module does in five sentences.";
  const lp = () => ({ model: MODEL, maxTokens: 300, messages: [{ role: "user", content: lpModule() }] });
  const measuredDecode = (tps: number) => {
    for (let i = 0; i < 3; i++) eta.decodeRates.record(MODEL, "cpu", tps);
  };
  const measuredPrefill = (tps: number, prompt = 4_600) => {
    for (let i = 0; i < 3; i++) eta.prefillRates.record(MODEL, "cpu", tps, Date.now(), prompt);
  };

  test("decode measured at 14 tok/s, no long prompt measured: read at the prefill prior (~24 tok/s), past the timeout; decode × 4 would have admitted it", () => {
    measuredDecode(14);
    const prompt = eta.promptTokenEstimate(jsonOf(lp()));
    expect(prompt).toBeGreaterThan(4_300);
    const est = eta.decodeEstimateMs(MODEL, "cpu", prompt, 300);
    expect(est.decodeFrom).toBe("measured");
    expect(est.prefillFrom).toBe("prior");
    expect(est.prefillTps).toBeLessThan(26);
    expect(est.ms).toBeGreaterThan(180_000);
    // Run 10's estimate: decode × COMPLETION_PREFILL_FACTOR, short-context decode.
    const old = eta.DECODE_ESTIMATE_OVERHEAD_MS + (prompt / (14 * eta.COMPLETION_PREFILL_FACTOR.cpu) + 300 / 14) * 1000;
    expect(old).toBeLessThan(162_000);
  });

  for (const prefill of [27, 35]) {
    test(`submit: hosts measured reading ~4.6k-token prompts at ${prefill} tok/s (decode 14 tok/s on short calls): refused at once, nothing reserved`, async () => {
      measuredDecode(14);
      measuredPrefill(prefill);
      const before = creditEngine.balance(requester.peerId);
      const { r, ms } = await submit(lp());
      expect(r.statusCode, r.body).toBe(503);
      expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy", limitMs: 162_000 });
      expect(r.json().completionEtaMs).toBeGreaterThan(162_000);
      expect(ms).toBeLessThan(2_000);
      expect(creditEngine.balance(requester.peerId)).toBe(before);
    });
  }

  test("a few fast measured samples never lift the prefill rate above the prior; short prompts do not count", () => {
    const decode = 14;
    for (let i = 0; i < 2; i++) eta.prefillRates.record(MODEL, "cpu", 80, Date.now(), 4_600);
    for (let i = 0; i < 5; i++) eta.prefillRates.record(MODEL, "cpu", 120, Date.now(), 2_500); // under 3/4 of the prompt
    const p = eta.completionPrefillTps(MODEL, "cpu", 4_600, decode);
    expect(p.from).toBe("prior");
    expect(p.tps).toBeCloseTo(eta.priorPrefillTps(MODEL, "cpu"), 5);
  });

  test("a reply after a long prompt is written slower than after a short one", () => {
    expect(eta.decodeContextFactor("cpu", 40)).toBeLessThan(1.01);
    expect(eta.decodeContextFactor("cpu", 4_600)).toBeGreaterThan(1.5);
    measuredDecode(10);
    expect(eta.decodeEstimateMs(MODEL, "cpu", 4_600, 300).effectiveDecodeTps).toBeLessThan(7);
  });

  test("a faster class measured on long prompts still gets the call", async () => {
    measuredDecode(14);
    measuredPrefill(120);
    const { r, taskId } = await submit(lp());
    expect(r.statusCode, r.body).toBe(200);
    const pulled = await pullAs(iad);
    expect(pulled.id).toBe(r.json().subtaskId);
    await finish(iad, taskId, pulled.id!);
  });

  test("admission logs the estimate's parts (prompt tokens, prefill rate and source, decode rate, total)", () => {
    measuredDecode(14);
    const body = lp();
    const check = inference.completionCheck(MODEL, "cpu", body.messages, undefined, 300, 180_000, Date.now(), { waiting: 0 });
    const log = inference.completionEstimateLog(check);
    expect(log).toMatchObject({ limitMs: 162_000, none: true });
    const cls = (log.classes as any[])[0];
    expect(cls).toMatchObject({ computeClass: "cpu", promptTokens: eta.promptTokenEstimate(jsonOf(body)), outputTokens: 300, prefillFrom: "prior", decodeFrom: "measured", decodeTps: 14 });
    expect(cls.prefillTps).toBeGreaterThan(0);
    expect(cls.rateMs).toBe(cls.prefillMs + cls.decodeMs + eta.DECODE_ESTIMATE_OVERHEAD_MS);
    expect(cls.completionEtaMs).toBeGreaterThan(162_000);
  });
});
