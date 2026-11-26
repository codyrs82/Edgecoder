import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, earnedMsat, grantCredits, NETWORK_FEE_POOL_ACCOUNT } from "../../src/credits/store.js";
import { tokenPriceUsdPerM, usdToMsat } from "../../src/economy/job-pricing.js";
import { OUTPUT_TOKEN_ALLOWANCE, PROMPT_TOKEN_ALLOWANCE } from "../../src/swarm/inference-streams.js";

/*
 * A model call's cost past its reserve (job-pricing.ts inferenceReserveMsat holds a local model's
 * prompt at its token estimate × 1.25 or bytes / 2, not one token per byte): the host is paid in full,
 * the rest taken from the buyer's balance with the host's earning (results.ts accrueResultCredits,
 * credits/store.ts accruePricedJobWithOverflow). Only what the buyer cannot cover goes unpaid, and is
 * recorded. The counts a host reports stay bounded by the request and reply (bytes + 2048, max_tokens
 * + 64), whatever the reserve. Real coordinator app (Fastify inject), in-memory credit store; the
 * Postgres transaction is covered by tests/credits/overflow-settle-pg.test.ts.
 */

const MESH = "mesh-secret-overflow-settle";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.48";
const BIG = "qwen3-coder:30b";
let portal: Server;
let app: any;
let ctx: typeof import("../../src/swarm/coordinator/context.js");
let mutable: any;
let cancelInferenceCall: typeof import("../../src/swarm/coordinator/inference-cancel.js")["cancelInferenceCall"];
const rich = createPeerKeys("agent-overflow-rich-buyer");
const poor = createPeerKeys("agent-overflow-poor-buyer");
const broke = createPeerKeys("agent-overflow-broke-buyer");
const worker = createPeerKeys("agent-overflow-worker");

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
  process.env.INFERENCE_COMPLETION_PRIOR_SPEED = "off";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  ctx = await import("../../src/swarm/coordinator/context.js");
  ({ mutable } = await import("../../src/swarm/coordinator/mutable-state.js"));
  ({ cancelInferenceCall } = await import("../../src/swarm/coordinator/inference-cancel.js"));
  await app.ready();
  for (const keys of [rich, poor, broke, worker]) {
    const payload = JSON.stringify({
      os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem,
      sandboxMode: "docker", installedModels: keys === worker ? [BIG] : [],
    });
    const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
    const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
    expect(res.statusCode).toBe(200);
  }
  await grantCredits(rich.peerId, 1_000_000, "test_funding");
  await grantCredits(poor.peerId, 1_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

function post(url: string, body: unknown, signer: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

/** Minified JSON with one-letter keys and values: ~2 bytes a token for a real tokenizer, ~4 by the estimate. */
const denseJson = (bytes: number) => {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const items: Array<Record<string, string>> = [];
  for (let i = 0; JSON.stringify(items).length < bytes; i++) items.push({ [letters[i % 26]]: letters[(i * 7) % 26] });
  return JSON.stringify(items);
};

const submit = (taskId: string, by: PeerKeys, content: string, maxTokens: number, maxCSats?: number) =>
  post("/inference/submit", { taskId, submitterAccountId: by.peerId, model: BIG, computeClass: "cpu", timeoutMs: 60_000, messages: [{ role: "user", content }], maxTokens, ...(maxCSats !== undefined ? { routing: { maxCSats } } : {}) }, by);

/** What the coordinator prices these counts at for the 30B band (the power floor is far below them here). */
function tokenCostMsat(promptTokens: number, outputTokens: number): number {
  const p = tokenPriceUsdPerM(30);
  return Math.round(usdToMsat((promptTokens * p.input + outputTokens * p.output) / 1e6, mutable.latestRateEpoch?.btcUsd ?? ctx.FALLBACK_BTC_USD));
}

/** Per task, from the in-memory ledger (cSats): set aside (reserve + overflow spends), paid (work + fee), refunded. */
function taskLedger(taskId: string, buyer: string) {
  const rows = creditEngine.history(buyer);
  const reserved = rows.filter((t) => t.type === "spend" && t.reason === "inference_reserve" && t.relatedTaskId === taskId).reduce((a, t) => a + t.credits, 0);
  const refunded = rows.filter((t) => t.type === "earn" && t.reason === `task_submit_refund:${taskId}`).reduce((a, t) => a + t.credits, 0);
  const work = creditEngine.history(worker.peerId).filter((t) => t.reason === "compute_contribution" && t.relatedTaskId === taskId).reduce((a, t) => a + t.credits, 0);
  const fee = creditEngine.history(NETWORK_FEE_POOL_ACCOUNT).filter((t) => t.reason === `network_fee:${taskId}`).reduce((a, t) => a + t.credits, 0);
  return { reserved, refunded, work, fee, overflowRows: rows.filter((t) => t.type === "spend" && t.relatedTaskId === taskId).length - 1 };
}

/** A reply of distinct words (a repeated character is judged degenerate and billed for its clean prefix only). */
const prose = (bytes: number) => {
  const words: string[] = [];
  let seed = 7;
  while (words.join(" ").length < bytes) {
    seed = (seed * 48271) % 2147483647;
    words.push(Array.from({ length: 3 + (seed % 6) }, (_, i) => String.fromCharCode(97 + ((seed >> (i * 3)) % 26))).join(""));
  }
  return words.join(" ").slice(0, bytes);
};

/** Claim, stream `reply`, report the counts and the result. */
async function run(taskId: string, subtaskId: string, reply: string, counts: { promptTokens: number; outputTokens: number }) {
  expect((await post("/pull", { agentId: worker.peerId }, worker)).json().subtask?.id).toBe(subtaskId);
  expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: reply }, worker)).statusCode).toBe(200);
  expect((await post("/inference/chunks", { subtaskId, seq: 1, delta: "", done: true, ...counts }, worker)).statusCode).toBe(200);
  expect((await post("/result", { subtaskId, taskId, agentId: worker.peerId, ok: true, output: reply, durationMs: 1_000 }, worker)).statusCode).toBe(200);
}

describe("a model call's cost past its reserve", () => {
  test("a dense prompt counted past the reserve: the host is paid in full from the buyer's balance; the ledger balances", async () => {
    const taskId = `inf-${randomUUID()}`;
    const sub = await submit(taskId, rich, denseJson(20_000), 16);
    expect(sub.statusCode, sub.body).toBe(200);
    const { subtaskId, reservedCSats } = sub.json();
    const inputBytes = Buffer.byteLength(ctx.queue.getSubtask(subtaskId)!.input, "utf8");
    const before = creditEngine.balance(rich.peerId) + reservedCSats;
    const earnedBefore = await earnedMsat(worker.peerId);
    // One token per byte of the request, the densest count /inference/chunks takes without clamping.
    await run(taskId, subtaskId, prose(200), { promptTokens: inputBytes, outputTokens: 16 });
    const priced = tokenCostMsat(inputBytes, 16);
    expect(priced).toBeGreaterThan(reservedCSats * 1000);
    const spentMsat = Math.round((before - creditEngine.balance(rich.peerId)) * 1000);
    const earned = (await earnedMsat(worker.peerId)) - earnedBefore;
    const l = taskLedger(taskId, rich.peerId);
    // Charged exactly the priced cost (not cut at the reserve); host + fee = the charge.
    expect(spentMsat).toBe(priced);
    expect(Math.round((l.work + l.fee) * 1000)).toBe(priced);
    expect(earned).toBe(Math.round(l.work * 1000));
    // The overflow is one more spend under the task's reserve reason: set aside = paid + refunded.
    expect(l.overflowRows).toBe(1);
    expect(Math.round(l.reserved * 1000)).toBe(Math.round((l.work + l.fee + l.refunded) * 1000));
    expect(l.refunded).toBe(0);
    const settled = ctx.settledBilling.get(taskId)!;
    expect(settled.overflowMsat).toBe(priced - reservedCSats * 1000);
    expect(settled.unpaidMsat).toBeUndefined();
    expect(ctx.taskBilling.has(taskId)).toBe(false);
  });

  test("a buyer who can't cover the rest: the host gets the reserve and what the balance holds; the shortfall is recorded, nothing goes negative", async () => {
    const taskId = `inf-${randomUUID()}`;
    const sub = await submit(taskId, poor, denseJson(20_000), 16);
    expect(sub.statusCode, sub.body).toBe(200);
    const { subtaskId, reservedCSats } = sub.json();
    const inputBytes = Buffer.byteLength(ctx.queue.getSubtask(subtaskId)!.input, "utf8");
    // The rest of the balance goes elsewhere while the call runs: 0.5 cSats left.
    creditEngine.spend(poor.peerId, creditEngine.balance(poor.peerId) - 0.5, "test_spent_elsewhere");
    await run(taskId, subtaskId, prose(200), { promptTokens: inputBytes, outputTokens: 16 });
    const priced = tokenCostMsat(inputBytes, 16);
    const l = taskLedger(taskId, poor.peerId);
    expect(creditEngine.balance(poor.peerId)).toBe(0);
    expect(Math.round((l.work + l.fee) * 1000)).toBe(reservedCSats * 1000 + 500);
    expect(Math.round(l.reserved * 1000)).toBe(Math.round((l.work + l.fee + l.refunded) * 1000));
    const settled = ctx.settledBilling.get(taskId)!;
    expect(settled.overflowMsat).toBe(500);
    expect(settled.unpaidMsat).toBe(priced - reservedCSats * 1000 - 500);
    // The usage record carries it too (reports, the account's usage page).
    await new Promise((r) => setTimeout(r, 10));
    const usage = ctx.memoryUsage.forAccount(poor.peerId, 0).find((u) => u.id === taskId);
    expect(usage?.unpaidMsat).toBe(settled.unpaidMsat);
    expect(usage?.costMsat).toBe(reservedCSats * 1000 + 500);
  });

  test("the buyer's maxCSats still bounds the whole cost: past it the host is not paid, and the buyer is not charged", async () => {
    // The hold this call gets without a ceiling, then the same call with a ceiling 0.4 cSats above it.
    const probe = `inf-${randomUUID()}`;
    const p = await submit(probe, rich, denseJson(20_000), 16);
    const hold = p.json().reservedCSats as number;
    const { cancelUnclaimedInference } = await import("../../src/swarm/coordinator/routes/inference.js");
    await cancelUnclaimedInference(probe, p.json().subtaskId);
    const taskId = `inf-${randomUUID()}`;
    const sub = await submit(taskId, rich, denseJson(20_000), 16, hold + 0.4);
    expect(sub.json().reservedCSats).toBe(hold);
    const { subtaskId } = sub.json();
    const inputBytes = Buffer.byteLength(ctx.queue.getSubtask(subtaskId)!.input, "utf8");
    const before = creditEngine.balance(rich.peerId) + hold;
    await run(taskId, subtaskId, prose(200), { promptTokens: inputBytes, outputTokens: 16 });
    const priced = tokenCostMsat(inputBytes, 16);
    const spentMsat = Math.round((before - creditEngine.balance(rich.peerId)) * 1000);
    expect(spentMsat).toBe(hold * 1000 + 400);
    const l = taskLedger(taskId, rich.peerId);
    expect(Math.round((l.work + l.fee) * 1000)).toBe(spentMsat);
    expect(Math.round(l.reserved * 1000)).toBe(Math.round((l.work + l.fee + l.refunded) * 1000));
    expect(ctx.settledBilling.get(taskId)?.unpaidMsat).toBe(priced - spentMsat);
  });

  test("a host that reports counts past the bound is clamped: bytes + 2048 in, max_tokens + 64 out", async () => {
    const taskId = `inf-${randomUUID()}`;
    const sub = await submit(taskId, rich, "y".repeat(4_000), 256);
    expect(sub.statusCode, sub.body).toBe(200);
    const { subtaskId } = sub.json();
    const inputBytes = Buffer.byteLength(ctx.queue.getSubtask(subtaskId)!.input, "utf8");
    const before = creditEngine.balance(rich.peerId) + sub.json().reservedCSats;
    await run(taskId, subtaskId, prose(5_000), { promptTokens: 10_000_000, outputTokens: 10_000_000 });
    const spentMsat = Math.round((before - creditEngine.balance(rich.peerId)) * 1000);
    expect(spentMsat).toBe(tokenCostMsat(inputBytes + PROMPT_TOKEN_ALLOWANCE, 256 + OUTPUT_TOKEN_ALLOWANCE));
    expect(spentMsat).toBeLessThan(tokenCostMsat(10_000_000, 10_000_000) / 1000);
  });

  test("a cancelled call the host stops: paid for its partial reply, the rest of the reserve comes back", async () => {
    const taskId = `inf-${randomUUID()}`;
    const sub = await submit(taskId, rich, "write a long story", 2_000);
    expect(sub.statusCode, sub.body).toBe(200);
    const { subtaskId, reservedCSats } = sub.json();
    const before = creditEngine.balance(rich.peerId) + reservedCSats;
    expect((await post("/pull", { agentId: worker.peerId }, worker)).json().subtask?.id).toBe(subtaskId);
    expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "Once upon a time" }, worker)).statusCode).toBe(200);
    expect(await cancelInferenceCall(taskId, subtaskId)).toBe("stopping");
    expect((await post("/inference/chunks", { subtaskId, seq: 1, delta: "", done: true, promptTokens: 30, outputTokens: 5 }, worker)).statusCode).toBe(200);
    expect((await post("/result", { subtaskId, taskId, agentId: worker.peerId, ok: true, output: "Once upon a time", durationMs: 500 }, worker)).statusCode).toBe(200);
    const l = taskLedger(taskId, rich.peerId);
    const spentMsat = Math.round((before - creditEngine.balance(rich.peerId)) * 1000);
    expect(spentMsat).toBeGreaterThan(0);
    expect(spentMsat).toBeLessThan(reservedCSats * 1000);
    expect(Math.round((l.work + l.fee) * 1000)).toBe(spentMsat);
    expect(Math.round(l.reserved * 1000)).toBe(Math.round((l.work + l.fee + l.refunded) * 1000));
    expect(l.overflowRows).toBe(0);
    expect(ctx.settledBilling.get(taskId)?.overflowMsat).toBeUndefined();
  });

  test("a timed-out call with a partial reply: paid on its estimated counts, within the reserve", async () => {
    const taskId = `inf-${randomUUID()}`;
    const sub = await submit(taskId, rich, "write a long story", 2_000);
    const { subtaskId, reservedCSats } = sub.json();
    const before = creditEngine.balance(rich.peerId) + reservedCSats;
    expect((await post("/pull", { agentId: worker.peerId }, worker)).json().subtask?.id).toBe(subtaskId);
    expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: prose(400) }, worker)).statusCode).toBe(200);
    expect((await post("/result", { subtaskId, taskId, agentId: worker.peerId, ok: false, output: "", error: "timed out after 60 s", durationMs: 60_000 }, worker)).statusCode).toBe(200);
    const l = taskLedger(taskId, rich.peerId);
    const spentMsat = Math.round((before - creditEngine.balance(rich.peerId)) * 1000);
    expect(spentMsat).toBeGreaterThan(0);
    expect(spentMsat).toBeLessThan(reservedCSats * 1000);
    expect(Math.round((l.work + l.fee) * 1000)).toBe(spentMsat);
    expect(Math.round(l.reserved * 1000)).toBe(Math.round((l.work + l.fee + l.refunded) * 1000));
  });

  test("402: says what the call sets aside and what it is expected to cost, in words and as data", async () => {
    const taskId = `inf-${randomUUID()}`;
    const res = await submit(taskId, broke, "y".repeat(8_000), 1_000);
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.error).toBe("insufficient_credits");
    expect(body.neededCSats).toBeGreaterThan(0);
    expect(body.expectedCSats).toBeGreaterThan(0);
    expect(body.expectedCSats).toBeLessThan(body.neededCSats);
    expect(body.message).toContain(`it sets aside up to ${body.neededCSats} cSats`);
    expect(body.message).toMatch(/expected cost about [\d.]+ cSats; unused cSats come back/);
  });
});
