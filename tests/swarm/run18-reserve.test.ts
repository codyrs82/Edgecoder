import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { describeJob } from "../../src/inference-api/job-descriptor.js";

/*
 * Network validation run 18 (main f6d5faeb): the same complex Auto prompt (~61k chars, three tools,
 * max_tokens 9000) from two accounts, both on the US coordinator, both 402 at submit:
 *
 * - inf-1795706577204-01367c0b (st5): best fit put it on the cloud (deepseek-v4.1-flash; the GPU
 *   host was busy with st5's standard call). Reserve: Flash's own worst case, 54.968 cSats.
 * - inf-1795706687095-618212e7 (st1, 95 cSats): the GPU host was free, so qwen3-coder:30b on gpu.
 *   Reserve: max(the 30b call's own bound, 127.1 cSats; the cloud overflow bound), and the overflow
 *   bound took every cloud model online, GLM-5.3 included: 221.665 cSats. Best fit never moves a job
 *   that does not ask for the best quality to GLM while Flash is online (best-fit.ts cloudTier), and
 *   the call placed on the cloud directly held Flash only.
 *
 * The run's BTC/USD is the ratio of the logged reserve to the one at the fallback price.
 */

const MESH = "mesh-secret-run18";
const REMOTE = "203.0.113.118";
const OWNER = "ops@edgecoder.io";
const TOKENS: Record<string, { ownerEmail: string; hostApproved: boolean }> = {
  "token-cloud": { ownerEmail: OWNER, hostApproved: true },
};
let portal: Server;
let app: any;
let economy: any;
let autoReplace: any;
let mutable: any;
let ctx: any;
let promptTokenEstimate: (text: string) => number;
const cloud = createPeerKeys("agent-run18-cloud");

/** The run-18 complex prompt (cx.mjs complex(1)) and the input the coordinator queues for it. */
const file = (name: string, n: number) => {
  const L = [`// ${name}.ts`];
  for (let i = 0; i < n; i++) L.push(`export function ${name}_${i}(input: Record<string, number>, k = ${i}): number {\n  let acc = 0;\n  for (const [key, v] of Object.entries(input)) { if (key.length % ${(i % 5) + 2} === 0) acc += v * k; else acc -= v / (k + 1); }\n  return Math.round(acc * 100) / 100;\n}`);
  return L.join("\n");
};
const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
const tools = [
  fn("read_file", "Read a file", { path: { type: "string" } }, ["path"]),
  fn("write_file", "Write a file", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  fn("run_shell", "Run a shell command", { cmd: { type: "string" } }, ["cmd"]),
];
const files = ["billing", "ledger", "routing", "dispatch"].map((f) => ({ f, src: file(`${f}1`, 60) }));
const messages = [
  { role: "system", content: "You are a coding agent working in a TypeScript repository. Use the tools to read and change files; finish with write_file calls." },
  { role: "user", content: `Refactor these four modules so every exported function validates its input map (throw on NaN), share a helper in src/util/validate.ts, update all call sites, and add tests. Files:\n\n${files.map((x) => `--- src/${x.f}.ts\n${x.src}`).join("\n\n")}` },
];
const MAX_TOKENS = 9000;
const TIMEOUT_MS = 180_000;
const inputBytes = Buffer.byteLength(JSON.stringify({ messages, tools, maxTokens: MAX_TOKENS, temperature: 0 }), "utf8");
const call = { inputBytes, maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS };
const cSats = (msat: number) => msat / 1000;
/** The 30b call's hold at the run's BTC/USD with the prompt bound of 2026-11-26. */
const RUN18_30B_RESERVE_CSATS = 83.525;

beforeAll(async () => {
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const t = TOKENS[body.registrationToken as string];
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/internal/nodes/validate" && t) res.end(JSON.stringify({ allowed: true, reason: "ok", node: { nodeId: body.nodeId, ...t } }));
      else res.end(JSON.stringify({ allowed: false, reason: "invalid_token" }));
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = MESH;
  process.env.CLOUD_HOST_OWNER_EMAILS = OWNER;
  process.env.COORDINATOR_STARTUP_GRACE_MS = "0";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  economy = await import("../../src/swarm/coordinator/economy.js");
  autoReplace = await import("../../src/swarm/coordinator/auto-replace.js");
  ({ mutable } = await import("../../src/swarm/coordinator/mutable-state.js"));
  ctx = await import("../../src/swarm/coordinator/context.js");
  ({ promptTokenEstimate } = await import("../../src/swarm/coordinator/start-eta.js"));
  await app.ready();
  // The run's cloud host serves both catalog models.
  await register(cloud, "token-cloud", { installedModels: ["deepseek-v4.1-flash", "glm-5.3"], hardwareProfile: { platform: "linux", arch: "x64", cpuCores: 2, ramGb: 2, cloud: { provider: "fireworks" } } });
}, 60_000);

afterAll(async () => {
  for (const k of ["COORDINATOR_STARTUP_GRACE_MS", "CLOUD_HOST_OWNER_EMAILS"]) delete process.env[k];
  if (mutable) mutable.latestRateEpoch = null;
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

async function register(keys: PeerKeys, token: string, extra: Record<string, unknown>) {
  const payload = JSON.stringify({ os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: token, publicKeyPem: keys.publicKeyPem, sandboxMode: "docker", ...extra });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
  expect(res.statusCode, res.body).toBe(200);
}

/** The run's BTC/USD: st5's logged 54.968 cSats over Flash's reserve for this call at the fallback price. */
function runBtcUsd(): number {
  mutable.latestRateEpoch = null;
  const atFallback = economy.inferenceCallReserve({ model: "deepseek-v4.1-flash", taskClass: "cloud", ...call }).reserveMsat;
  return (ctx.FALLBACK_BTC_USD * atFallback) / 54_968;
}

describe("run 18: a complex Auto call holds the worst case of where it can run", () => {
  test("the replayed prompt is the run's (61,400 chars of messages)", () => {
    expect(JSON.stringify(messages).length).toBe(61_400);
  });

  test("a job that asks for the best quality still holds the premium model's worst case", () => {
    const job = describeJob({ messages: messages as any, tools: tools as any, maxTokens: MAX_TOKENS }, { quality: "best" } as any);
    // Top-tier complexity (best-fit.ts AUTO_CLOUD_MIN_COMPLEXITY) and the best quality: GLM may win.
    const best = { ...job, complexity: { ...job.complexity, score: 0.9 } };
    const glm = economy.inferenceCallReserve({ model: "glm-5.3", taskClass: "cloud", ...call }).reserveMsat;
    expect(autoReplace.cloudOverflowReserveMsat({ ...call, job: best })).toBe(glm);
  });

  test("inf-1795706577204-01367c0b (st5, placed on the cloud): Flash's own worst case, 54.968 cSats, unchanged", () => {
    mutable.latestRateEpoch = { btcUsd: runBtcUsd() };
    try {
      const r = economy.inferenceCallReserve({ model: "deepseek-v4.1-flash", taskClass: "cloud", ...call });
      expect(cSats(r.reserveMsat)).toBeCloseTo(54.968, 1);
      expect(r.floorMsat).toBe(0);
    } finally {
      mutable.latestRateEpoch = null;
    }
  });

  test("inf-1795706687095-618212e7 (st1, placed on the GPU 30b): held GLM's 221.665 cSats, now the larger of its own bound and Flash's", () => {
    mutable.latestRateEpoch = { btcUsd: runBtcUsd() };
    try {
      const job = describeJob({ messages: messages as any, tools: tools as any, maxTokens: MAX_TOKENS }, {});
      expect(job.quality).not.toBe("best");
      const own = economy.inferenceCallReserve({ model: "qwen3-coder:30b", taskClass: "gpu", ...call }).reserveMsat;
      const flash = economy.inferenceCallReserve({ model: "deepseek-v4.1-flash", taskClass: "cloud", ...call }).reserveMsat;
      const glm = economy.inferenceCallReserve({ model: "glm-5.3", taskClass: "cloud", ...call }).reserveMsat;
      // What the run held: GLM's worst case, above the 30b call's own bound.
      expect(cSats(glm)).toBeCloseTo(221.665, 1);
      expect(glm).toBeGreaterThan(own);
      // Now: the overflow holds Flash, the cloud model best fit would move this job to.
      const overflow = autoReplace.cloudOverflowReserveMsat({ ...call, job });
      expect(overflow).toBe(flash);
      const reserve = Math.max(own, overflow);
      expect(reserve).toBe(own);
      expect(cSats(reserve)).toBeGreaterThan(54.968);
      expect(cSats(reserve)).toBeLessThan(221.665 * 0.6);
    } finally {
      mutable.latestRateEpoch = null;
    }
  });

  test("the 30b call's own hold: its prompt at bytes / 2 (the estimate × 1.25 is less), not one token per byte", () => {
    const queued = JSON.stringify({ messages, tools, maxTokens: MAX_TOKENS, temperature: 0 });
    expect(inputBytes).toBe(62_015);
    const estimate = promptTokenEstimate(queued);
    expect(estimate).toBe(18_151);
    const btcUsd = runBtcUsd();
    expect(btcUsd).toBeGreaterThan(60_800);
    expect(btcUsd).toBeLessThan(60_900);
    mutable.latestRateEpoch = { btcUsd };
    try {
      const r = economy.inferenceCallReserve({ model: "qwen3-coder:30b", taskClass: "gpu", ...call, promptTokens: estimate });
      // 127.1 cSats in the run; the prompt bound is now 31,008 + 2,048 tokens (was 62,015 + 2,048).
      expect(cSats(r.reserveMsat)).toBeCloseTo(RUN18_30B_RESERVE_CSATS, 3);
      expect(cSats(r.reserveMsat)).toBeLessThan(127.1 * 0.7);
      // Flash's worst case is still below it, so an Auto call placed on the 30b holds this.
      expect(r.reserveMsat).toBeGreaterThan(economy.inferenceCallReserve({ model: "deepseek-v4.1-flash", taskClass: "cloud", ...call }).reserveMsat);
    } finally {
      mutable.latestRateEpoch = null;
    }
  });

  test("st1's 402 would say what the 30b call sets aside and what it is expected to cost", async () => {
    const { completionWork, insufficientCreditsBody } = await import("../../src/swarm/coordinator/routes/inference.js");
    const { expectedOutputTokens } = await import("../../src/swarm/coordinator/expected-output.js");
    mutable.latestRateEpoch = { btcUsd: runBtcUsd() };
    try {
      const job = describeJob({ messages: messages as any, tools: tools as any, maxTokens: MAX_TOKENS }, {});
      const work = completionWork(messages as any, tools, MAX_TOKENS, expectedOutputTokens(job));
      const reserve = economy.inferenceCallReserve({ model: "qwen3-coder:30b", taskClass: "gpu", ...call, promptTokens: promptTokenEstimate(JSON.stringify({ messages, tools, maxTokens: MAX_TOKENS, temperature: 0 })) }).reserveMsat;
      const expected = economy.inferenceCallExpectedMsat({ model: "qwen3-coder:30b", taskClass: "gpu", timeoutMs: TIMEOUT_MS, ...work });
      const body = insufficientCreditsBody(reserve, expected);
      expect(body.neededCSats).toBeCloseTo(RUN18_30B_RESERVE_CSATS, 3);
      expect(body.expectedCSats).toBeGreaterThan(0);
      expect(body.expectedCSats).toBeCloseTo(18.407, 3);
      expect(body.message).toBe(`Not enough cSats for this request (it sets aside up to ${body.neededCSats} cSats; expected cost about ${Math.round(body.expectedCSats)} cSats; unused cSats come back).`);
    } finally {
      mutable.latestRateEpoch = null;
    }
  });

  test("without a job (no tier known) the overflow keeps the largest model's worst case", () => {
    const glm = economy.inferenceCallReserve({ model: "glm-5.3", taskClass: "cloud", ...call }).reserveMsat;
    expect(autoReplace.cloudOverflowReserveMsat(call)).toBe(glm);
  });

  test("a call limited to a class without the cloud holds no overflow", () => {
    expect(autoReplace.cloudOverflowReserveMsat({ ...call, onlyClass: "gpu" })).toBe(0);
  });
});
