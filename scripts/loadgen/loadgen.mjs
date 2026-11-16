#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Load generator for the live (regtest) EdgeCoder network. No dependencies; Node 22.
 *
 * Virtual users (one per test account) are buyers on the public OpenAI-compatible API. Each has a
 * persona (profiles.mjs) that weights three behaviours: chat (short checkable Q&A), coding
 * (multi-turn tool-using session growing to ~20K tokens, with think time between turns) and burst
 * (concurrent one-offs). Arrivals are open-loop (Poisson) at the stage's rate; a ready coding turn
 * takes the next arrival before anything new starts.
 *
 * Safety:
 *   - HARD_MAX_RATE (16 calls/s) for the whole network: this machine never starts more than
 *     floor(cap / machines) calls in any sliding second.
 *   - hold, don't stop: if the error rate over 30 s passes the profile's threshold, the rate steps
 *     down and is held there (planner.mjs RateGovernor) until --duration ends. The sustain profile
 *     finds the rate that keeps 70-85% of the slots busy and holds it. A run stops early only for
 *     real failure: auth errors, budget exhausted, every buyer out of cSats, coordinator down.
 *   - budget: a user stops below LOADGEN_MIN_BALANCE cSats or after --buyer-cap cSats; the machine
 *     stops after its share of LOADGEN_BUDGET_CSATS.
 *   - buyers (--buyers / LOADGEN_BUYERS, default every account) and LOADGEN_AVOID (JSON
 *     { buyer: [model, ...] }, from budget.mjs buyers): a buyer never asks for a model its own
 *     agents hold, so its money goes to other accounts (fly.sh fills both). Model "auto" is safe
 *     for every buyer: best-fit routing never places a call on the requester's own agents.
 *   - --auto-share (LOADGEN_AUTO_SHARE, default 0.5): the share of calls sent as model "auto"
 *     (the coordinator's best-fit routing); 0 sends only named models.
 *   - API keys are read from LOADGEN_KEYS (JSON {name: key}) or from account files; never printed.
 *
 * Output: JSON lines on stdout (LOADGEN_START, LOADGEN_TICK, LOADGEN_EVENT, LOADGEN_STAGE,
 * LOADGEN_SUMMARY) plus a summary table; the raw, mergeable stage aggregates go to the results
 * file (LOADGEN_RESULTS) that report.mjs collects.
 *
 *   node scripts/loadgen/loadgen.mjs --profile smoke --users st1,st2          (local, one machine)
 *   node scripts/loadgen/loadgen.mjs --profile ramp --dry-run                  (print the schedule)
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HARD_MAX_RATE, PERSONAS, MODELS, buildSchedule, codingContext, parseDuration } from "./profiles.mjs";
import { StageStats, classifyCall, digestStage, isFailure, table } from "./stats.mjs";
import { CapacityPlanner, RateGovernor, fatalStop, parseModelId, pickWithAutoShare } from "./planner.mjs";
import { fetchCapacity } from "./capacity.mjs";
import { CodingSession, codegenSize, codegenTask, modelMix, pickWeighted, question, rng } from "./workload.mjs";

// ---------------------------------------------------------------------------- configuration
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? "true" : v;
};
const env = process.env;
const opt = (name, envName, dflt) => flag(name) ?? env[envName] ?? dflt;

const URL_ = opt("url", "LOADGEN_URL", "https://edgecoder.io").replace(/\/$/, "");
const PROFILE = opt("profile", "LOADGEN_PROFILE", "smoke");
const REGIONS = (opt("regions", "LOADGEN_REGIONS", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const REGION = env.FLY_REGION ?? opt("region", "LOADGEN_REGION", "local");
const MACHINES = REGIONS.length || Number(opt("machines", "LOADGEN_MACHINES", 1));
const INDEX = REGIONS.length ? REGIONS.indexOf(REGION) : Number(opt("index", "LOADGEN_INDEX", 0));
const RUN_ID = opt("run-id", "LOADGEN_RUN_ID", `lg-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`);
const START_AT = Number(opt("start-at", "LOADGEN_START_AT", 0)) || Date.now() + 2_000;
const BUDGET = Number(opt("budget", "LOADGEN_BUDGET_CSATS", 2_000));
const MIN_BALANCE = Number(opt("min-balance", "LOADGEN_MIN_BALANCE", 1000));
// Most one buyer may spend in this run (all machines together); 0 = no cap beyond the balance floor.
const BUYER_CAP = Number(opt("buyer-cap", "LOADGEN_BUYER_CAP_CSATS", 0));
const MIN_RATE = Number(opt("min-rate", "LOADGEN_MIN_RATE", 0.02));
const MAX_INFLIGHT = Number(opt("max-inflight", "LOADGEN_MAX_INFLIGHT", 48));
// A stream with no byte for this long (the portal sends a keepalive comment every 15 s) is cut by the
// client and counted as stream_idle_timeout; 0 turns the check off.
const IDLE_MS = Number(opt("idle-ms", "LOADGEN_IDLE_MS", 60_000));
const LINGER_SEC = Number(opt("linger", "LOADGEN_LINGER_SEC", 0));
const RESULTS = opt("results", "LOADGEN_RESULTS", join(tmpdir(), `loadgen-${RUN_ID}-${REGION}.jsonl`));
const DRY = flag("dry-run") === "true";
// Capacity: a snapshot from the operator (fly.sh passes capacity.mjs output as LOADGEN_CAPACITY),
// refreshed before every stage when an admin token is available (LOADGEN_ADMIN_TOKEN, optional).
const ADMIN_TOKEN = env.LOADGEN_ADMIN_TOKEN ?? "";
const OVERSUB = Number(opt("oversub", "LOADGEN_OVERSUB", 1.5));
const AUTO_SLOTS = Number(opt("auto-slots", "LOADGEN_AUTO_SLOTS", 3));
// Share of calls (chat, burst, codegen and new coding sessions) sent as model "auto", so the run
// exercises the coordinator's best-fit routing and fills Settings > Network's "Routing decisions".
// 0 = every call names a model. The rest are spread over the model mix as before.
const AUTO_SHARE = Math.min(1, Math.max(0, Number(opt("auto-share", "LOADGEN_AUTO_SHARE", 0.5)) || 0));
let initialCapacity = null;
try { initialCapacity = env.LOADGEN_CAPACITY ? JSON.parse(env.LOADGEN_CAPACITY) : null; } catch { initialCapacity = null; }
const UA = "edgecoder-loadgen/1.0 (+https://github.com/codyrs82/Edgecoder; regtest load test)";

const schedule = buildSchedule(PROFILE, {
  durationSec: parseDuration(opt("duration", "LOADGEN_DURATION", undefined)),
  rate: opt("rate", "LOADGEN_RATE", undefined) !== undefined ? Number(opt("rate", "LOADGEN_RATE")) : undefined,
  stageSeconds: opt("stage-minutes", "LOADGEN_STAGE_MINUTES", undefined) !== undefined ? Math.round(Number(opt("stage-minutes", "LOADGEN_STAGE_MINUTES")) * 60) : undefined,
  loop: flag("loop") === "true" || env.LOADGEN_LOOP === "1" ? true : undefined,
  maxRate: opt("max-rate", "LOADGEN_MAX_RATE", undefined) !== undefined ? Number(opt("max-rate", "LOADGEN_MAX_RATE")) : undefined,
});
const PER_SECOND_LIMIT = Math.floor(Math.min(HARD_MAX_RATE, schedule.cap) / MACHINES);
if (PER_SECOND_LIMIT < 1) {
  console.error(`${MACHINES} machines cannot share a ${schedule.cap} calls/s cap (each needs at least 1/s); use fewer regions`);
  process.exit(2);
}

const out = (tag, o) => {
  const line = `${tag} ${JSON.stringify({ run: RUN_ID, region: REGION, ...o })}`;
  console.log(line);
};
const save = (o) => {
  try { appendFileSync(RESULTS, JSON.stringify({ run: RUN_ID, region: REGION, ...o }) + "\n"); } catch {}
};

if (INDEX < 0 || INDEX >= MACHINES) {
  console.error(`region ${REGION} is not in LOADGEN_REGIONS (${REGIONS.join(",")}); idle`);
  if (LINGER_SEC) await new Promise((r) => setTimeout(r, LINGER_SEC * 1000));
  process.exit(2);
}

/** API keys: LOADGEN_KEYS (JSON name -> key) or the e2e account files. Never printed. */
function loadKeys() {
  if (env.LOADGEN_KEYS) return JSON.parse(env.LOADGEN_KEYS);
  const dir = opt("keys-dir", "LOADGEN_KEYS_DIR", join(homedir(), ".config/edgecoder/e2e/accounts"));
  const keys = {};
  if (!existsSync(dir)) return keys;
  for (const f of readdirSync(dir)) {
    const mt = /^(st\d+)\.json$/.exec(f);
    if (!mt) continue;
    try { const k = JSON.parse(readFileSync(join(dir, f), "utf8")).apiKey; if (k) keys[mt[1]] = k; } catch {}
  }
  return keys;
}
const allKeys = loadKeys();
const only = (opt("buyers", "LOADGEN_BUYERS", "") || opt("users", "LOADGEN_USERS", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
let AVOID = {};
try { AVOID = JSON.parse(opt("avoid", "LOADGEN_AVOID", "") || "{}"); } catch { AVOID = {}; }
const names = Object.keys(allKeys).filter((n) => !only.length || only.includes(n)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
const personaNames = Object.keys(PERSONAS);
// Fewer buyers than machines: every machine uses every buyer (caps are then split between machines).
const SHARED = names.length < MACHINES;
const newMoney = () => ({ calls: 0, ok: 0, cSats: 0, byModel: {}, ownCalls: 0, ownCSats: 0, servedSeen: 0 });
const users = names
  .map((name, j) => ({ name, j }))
  .filter(({ j }) => SHARED || j % MACHINES === INDEX)
  .map(({ name, j }) => ({
    name, key: allKeys[name], persona: personaNames[j % personaNames.length], balance: null, spent: 0, stopped: null, sessions: 0,
    avoid: new Set((AVOID[name] ?? []).map((m) => parseModelId(m).key)), money: newMoney(),
  }));
const USER_CAP = BUYER_CAP > 0 ? BUYER_CAP / (SHARED ? MACHINES : 1) : Infinity;

out("LOADGEN_START", {
  profile: PROFILE, url: URL_, machines: MACHINES, index: INDEX, perSecondLimit: PER_SECOND_LIMIT, networkCap: schedule.cap, autoShare: AUTO_SHARE,
  startAt: new Date(START_AT).toISOString(), durationSec: schedule.durationSec, loop: schedule.loop,
  stages: schedule.stages.map((s) => ({ i: s.index, rate: s.rate, sec: s.seconds })), breach: schedule.breach,
  users: users.map((u) => ({ name: u.name, persona: u.persona, avoid: [...u.avoid] })), budgetCSats: BUDGET / MACHINES, buyerCapCSats: Number.isFinite(USER_CAP) ? USER_CAP : null, minBalance: MIN_BALANCE, results: RESULTS,
  adaptive: schedule.adaptive, startRate: schedule.startRate ?? null,
});
if (DRY) process.exit(0);
if (!users.length) { console.error("no users (API keys) for this machine"); process.exit(2); }
writeFileSync(RESULTS, "");
save({ type: "start", profile: PROFILE, startAt: START_AT, schedule, machines: MACHINES, users: users.map((u) => u.name) });

// ---------------------------------------------------------------------------- HTTP
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function balance(u) {
  try {
    const r = await fetch(`${URL_}/v1/account`, { headers: { authorization: `Bearer ${u.key}`, "user-agent": UA }, signal: AbortSignal.timeout(20_000) });
    if (r.status !== 200) return null;
    const j = await r.json();
    return Number(j.cSats ?? 0);
  } catch { return null; }
}

/**
 * One streamed chat completion. Returns the measured result; never throws.
 * body: OpenAI request (model, messages, tools, max_tokens).
 *
 * How a failed call ended is classified by classifyCall (stats.mjs): the client's deadline, an idle
 * stream (no byte, keepalive comments included, for IDLE_MS: the portal sends one every 15 s), a
 * connection cut before or after the first token, an edge proxy's error page, or an error event
 * inside the stream. The response's ids (cf-ray, fly-request-id, x-request-id) and timings go with
 * the error (`meta`), so LOADGEN_ERR lines can be matched to the portal's and coordinator's logs.
 */
async function chatCall(u, body, { timeoutMs, sessionId }) {
  const t0 = performance.now();
  let ttft = null, text = "", status = 0, errBody = "", cSats = 0, usage = null, where = null, served = null;
  let failure = null, gotHeaders = false, sawDone = false, inband = false, keepalives = 0, bytes = 0, lastByte = t0, headersMs = null;
  const ids = {};
  const toolCalls = [];
  const ctl = new AbortController();
  const deadline = setTimeout(() => { failure ??= "timeout"; ctl.abort(); }, timeoutMs);
  const idle = IDLE_MS > 0
    ? setInterval(() => { if (performance.now() - lastByte > IDLE_MS) { failure ??= "idle"; ctl.abort(); } }, Math.min(1000, IDLE_MS))
    : null;
  try {
    const res = await fetch(`${URL_}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${u.key}`, "content-type": "application/json", "user-agent": UA,
        // Where this buyer runs (FLY_REGION on Fly): the portal records it with its coordinator choice
        // (routing decisions on Settings > Network). Recorded, not scored: the portal relays the call,
        // so its own round trip to each coordinator is what decides.
        "x-edgecoder-client-region": REGION,
        ...(sessionId ? { "x-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ ...body, stream: true, temperature: 0, ...(sessionId ? { user: sessionId } : {}) }),
      signal: ctl.signal,
    });
    status = res.status;
    gotHeaders = true;
    lastByte = performance.now();
    headersMs = Math.round(lastByte - t0);
    for (const h of ["cf-ray", "fly-request-id", "x-request-id"]) { const v = res.headers.get(h); if (v) ids[h] = v; }
    if (!res.ok || !res.body) errBody = (await res.text().catch(() => "")).slice(0, 300);
    else {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        lastByte = performance.now();
        bytes += chunk.byteLength ?? chunk.length ?? 0;
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.startsWith(":")) { keepalives++; continue; }
          if (line === "data: [DONE]") { sawDone = true; continue; }
          if (!line.startsWith("data: ")) continue;
          let j;
          try { j = JSON.parse(line.slice(6)); } catch { continue; }
          if (j.error) { inband = true; errBody = JSON.stringify(j.error).slice(0, 300); }
          const d = j.choices?.[0]?.delta;
          if (d?.content) { if (ttft === null) ttft = performance.now() - t0; text += d.content; }
          if (d?.tool_calls?.length) { if (ttft === null) ttft = performance.now() - t0; toolCalls.push(...d.tool_calls); }
          if (j.usage) usage = j.usage;
          if (j.edgecoder?.cSatsSpent !== undefined) cSats = Number(j.edgecoder.cSatsSpent) || 0;
          if (j.edgecoder?.where) where = String(j.edgecoder.where);
          // Not sent by /v1/chat/completions today; used when it is (exact self-dealing count).
          if (j.edgecoder?.served && typeof j.edgecoder.served === "object") served = { own: j.edgecoder.served.own === true, computeClass: j.edgecoder.served.computeClass ?? null };
        }
      }
    }
  } catch (e) {
    failure ??= "network";
    if (!errBody) errBody = String(e?.cause?.code ?? e?.message ?? e).slice(0, 200);
  } finally {
    clearTimeout(deadline);
    if (idle) clearInterval(idle);
  }
  const now = performance.now();
  const totalMs = Math.round(now - t0);
  const error = classifyCall({ status: failure === "timeout" ? "timeout" : status, errBody, failure, gotHeaders, tokens: ttft !== null, sawDone, inband });
  const meta = error
    ? { ttftMs: ttft === null ? null : Math.round(ttft), totalMs, headersMs, sinceLastByteMs: Math.round(now - lastByte), keepalives, bytes, ...(Object.keys(ids).length ? { ids } : {}) }
    : undefined;
  return {
    status, error, errDetail: error ? errBody.slice(0, 160) : undefined, meta, ttftMs: ttft === null ? null : Math.round(ttft), totalMs, text, toolCalls,
    cSats, where, served, promptTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------- rate limiting
/** At most `limit` call starts in any sliding second (this machine's share of the hard cap). */
const starts = [];
let waiting = 0;
async function takeSlot() {
  waiting++;
  try {
    for (;;) {
      const now = Date.now();
      while (starts.length && now - starts[0] >= 1000) starts.shift();
      if (starts.length < PER_SECOND_LIMIT) { starts.push(now); return; }
      await sleep(1000 - (now - starts[0]) + 1);
    }
  } finally { waiting--; }
}

// ---------------------------------------------------------------------------- run state
const planner = new CapacityPlanner({ machines: MACHINES, index: INDEX, oversub: OVERSUB, autoSlots: AUTO_SLOTS, autoShare: AUTO_SHARE, capacity: initialCapacity });
const rewritten = new Set();
const R = rng(Number.parseInt(RUN_ID.replace(/\D/g, "").slice(-8) || "1", 10) + INDEX * 7919);
let current = null; // StageStats of the stage now running
const stageStats = [];
let inflight = 0;
let stopReason = null;
let machineSpent = 0;
const recent = []; // { atMs, error, type } of finished calls, for the breach check (error = a real failure)
const droppedModels = new Map(); // capacity key -> until (ms): the network refused it (gone, restricted)
const refusals = {};
const REFUSED = new Set(["model_not_found", "no_agent_has_model", "http_403"]);
const readySessions = []; // coding sessions waiting for their next turn
let seq = 0;
let debt = 0; // arrivals a burst already used (a burst of k calls stands for k arrivals)

function record(stats, u, behaviour, model, r, correct, extra = {}) {
  const res = { behaviour, model, error: r.error, ttftMs: r.ttftMs, totalMs: r.totalMs, correct, cSats: r.cSats, promptTokens: r.promptTokens, outputTokens: r.outputTokens, where: r.where };
  stats.add(res);
  recent.push({ atMs: Date.now(), error: isFailure(r.error), type: r.error });
  u.spent += r.cSats ?? 0;
  machineSpent += r.cSats ?? 0;
  const mo = u.money;
  mo.calls++;
  if (!r.error) mo.ok++;
  mo.cSats += r.cSats ?? 0;
  const bm = (mo.byModel[model] ??= { calls: 0, cSats: 0 });
  bm.calls++;
  bm.cSats += r.cSats ?? 0;
  if (r.served) { mo.servedSeen++; if (r.served.own) { mo.ownCalls++; mo.ownCSats += r.cSats ?? 0; } }
  // A model the network keeps refusing (gone, or restricted) leaves the mix for 10 minutes.
  const key = parseModelId(model).key;
  if (REFUSED.has(r.error) && key !== "auto" && (refusals[key] = (refusals[key] ?? 0) + 1) >= 3) {
    refusals[key] = 0;
    droppedModels.set(key, Date.now() + 600_000);
    out("LOADGEN_EVENT", { type: "model_dropped", model: key, error: r.error, minutes: 10 });
  }
  if (mo.cSats >= USER_CAP && !u.stopped) {
    u.stopped = "buyer_cap";
    out("LOADGEN_EVENT", { type: "user_stopped", user: u.name, reason: "buyer_cap", cSats: Math.round(mo.cSats * 1000) / 1000 });
  }
  // Every error while they are few, then every 20th (the stage lines carry the full counts).
  if (r.error && (process.env.LOADGEN_VERBOSE === "1" || stats.errLogged++ < 30 || stats.errLogged % 20 === 0)) out("LOADGEN_ERR", { user: u.name, behaviour, model, error: r.error, status: r.status, detail: r.errDetail, ...(r.meta ?? {}), ...extra });
  if (u.balance !== null && u.balance - u.spent < MIN_BALANCE && !u.stopped) {
    u.stopped = "low_balance";
    out("LOADGEN_EVENT", { type: "user_stopped", user: u.name, reason: "low_balance", balance: Math.round(u.balance - u.spent) });
  }
  if (r.error === "insufficient_funds" && !u.stopped) {
    // Each call sets aside a reserve up front (~750 cSats for a long 30b call), so a 402 can mean
    // "too many calls at once" rather than "empty": pause a minute, then the balance refresh decides.
    u.pausedUntil = Date.now() + 60_000;
    out("LOADGEN_EVENT", { type: "user_paused", user: u.name, reason: "insufficient_funds", seconds: 60 });
  }
  if (machineSpent > BUDGET / MACHINES && !stopReason) stopReason = "budget_exhausted";
}

/** The behaviour's model mix now: from the capacity snapshot, less models the network refused. */
function weightsFor(behaviour) {
  const w = modelMix(planner.capacity, behaviour, MODELS[behaviour]);
  const now = Date.now();
  for (const id of Object.keys(w)) {
    const until = droppedModels.get(parseModelId(id).key);
    if (until && until > now) delete w[id];
  }
  return w;
}

/** Pick "auto" (AUTO_SHARE of calls) or a model with room (planner) that this buyer's own agents do not hold. */
function pickModel(behaviour, u) {
  const m = pickWithAutoShare(planner, weightsFor(behaviour), R, u?.avoid, AUTO_SHARE);
  if (m?.rewrittenFrom && !rewritten.has(m.rewrittenFrom)) {
    rewritten.add(m.rewrittenFrom);
    out("LOADGEN_EVENT", { type: "class_unavailable", asked: m.rewrittenFrom, sent: m.id, note: "no machine holds the model in that class; sent without the class" });
  }
  return m;
}

/** One streamed call against the planner's per-model in-flight count. */
async function plannedCall(u, m, body, opts) {
  const atCap = planner.start(m.key);
  let r;
  try {
    await takeSlot();
    inflight++;
    try { r = await chatCall(u, { ...body, model: m.id }, opts); } finally { inflight--; }
  } catch (e) {
    planner.finish(m.key, null, atCap);
    throw e;
  }
  r.error = planner.finish(m.key, r.error, atCap);
  return r;
}

async function doChat(u, stats, behaviour) {
  const m = pickModel(behaviour, u);
  if (!m) { stats.drop("capacity"); return; }
  const { q, ok } = question(seq++);
  const r = await plannedCall(u, m, { max_tokens: 16, messages: [{ role: "user", content: q }] }, { timeoutMs: 120_000 });
  record(stats, u, behaviour, m.id, r, r.error ? null : ok(r.text));
}

async function doBurst(u, stats) {
  const k = 2 + Math.floor(R() * 4);
  debt += k - 1;
  await Promise.all(Array.from({ length: k }, () => doChat(u, stats, "burst")));
}

/** One code-generation call: a module as context, a function and tests out (hundreds of tokens). */
async function doCodegen(u, stats) {
  const m = pickModel("codegen", u);
  if (!m) { stats.drop("capacity"); return; }
  const { contextTokens, maxTokens } = codegenSize(m.key, planner.capacity, schedule.codingContextScale);
  const t = codegenTask(R, seq++, contextTokens);
  const r = await plannedCall(u, m, { max_tokens: maxTokens, messages: t.messages }, { timeoutMs: 300_000 });
  record(stats, u, "codegen", m.id, r, r.error ? null : t.ok(r.text), { contextTokens: t.contextTokens });
}

function newSession(u) {
  const m = pickModel("coding", u);
  if (!m) return null;
  const full = codingContext(m.id);
  const target = Math.max(2_500, Math.round(full * schedule.codingContextScale));
  u.sessions++;
  const s = new CodingSession({ id: `${RUN_ID}-${REGION}-${u.name}-${randomUUID().slice(0, 8)}`, model: m.id, seed: Math.floor(R() * 2 ** 31), targetTokens: target, startTokens: 2_000, maxTurns: schedule.codingContextScale < 1 ? 4 : 12 });
  s.planned = m;
  return s;
}

async function doCodingTurn(u, s, stats) {
  const { messages, tools, contextTokens } = s.next();
  const r = await plannedCall(u, s.planned, { max_tokens: 160, messages, tools }, { timeoutMs: 300_000, sessionId: s.id });
  const correct = r.error ? null : s.record({ text: r.text, toolCalls: r.toolCalls });
  record(stats, u, "coding", s.model, r, correct, { session: s.id, turn: s.turn, contextTokens });
  if (r.error || s.done || stopReason || u.stopped) {
    u.sessions--;
    return;
  }
  // Think time before the next turn: a person reading the answer and typing (5-20 s).
  s.readyAtMs = Date.now() + 5_000 + R() * 15_000;
  s.user = u;
  readySessions.push(s);
}

/** One arrival: continue a ready coding session, or start something new for a random user. */
function arrival(stats) {
  if (debt > 0) { debt--; return; }
  if (inflight >= MAX_INFLIGHT || waiting > PER_SECOND_LIMIT * 5) { stats.drop("inflight_cap"); return; }
  const now = Date.now();
  // A session whose think time is over and whose model has room takes this arrival.
  const ready = readySessions.findIndex((s) => s.readyAtMs <= now && planner.headroom(s.planned.key) > 0);
  if (ready >= 0) {
    const [s] = readySessions.splice(ready, 1);
    if (!s.user.stopped && !(s.user.pausedUntil > now)) { void doCodingTurn(s.user, s, stats); return; }
    s.user.sessions--;
  }
  // Sessions that waited over 2 minutes for room on their model end (a user giving up).
  for (let i = readySessions.length - 1; i >= 0; i--) {
    if (now - readySessions[i].readyAtMs > 120_000) { readySessions[i].user.sessions--; readySessions.splice(i, 1); stats.drop("session_gave_up"); }
  }
  const active = users.filter((u) => !u.stopped && !(u.pausedUntil > now));
  if (!active.length) {
    if (!users.some((u) => !u.stopped)) stopReason ??= "all_users_stopped";
    stats.drop("no_user");
    return;
  }
  const u = active[Math.floor(R() * active.length)];
  let b = pickWeighted(PERSONAS[u.persona], R);
  if (b === "coding" && u.sessions >= (u.persona === "coder" ? 2 : 1)) b = "chat";
  const s = b === "coding" ? newSession(u) : null;
  if (s) void doCodingTurn(u, s, stats);
  else if (b === "burst") void doBurst(u, stats);
  else if (b === "codegen") void doCodegen(u, stats);
  else void doChat(u, stats, "chat");
}

// ---------------------------------------------------------------------------- main
for (const u of users) {
  u.balance = await balance(u);
  if (u.balance === null) { u.stopped = "balance_unavailable"; }
  else if (u.balance < MIN_BALANCE) { u.stopped = "low_balance"; }
  out("LOADGEN_USER", { user: u.name, persona: u.persona, cSats: u.balance === null ? null : Math.round(u.balance * 1000) / 1000, active: !u.stopped, reason: u.stopped ?? undefined });
}
if (!users.some((u) => !u.stopped)) { out("LOADGEN_EVENT", { type: "abort", reason: "no user has enough cSats (run scripts/loadgen/budget.mjs topup)" }); process.exit(3); }

setInterval(async () => {
  for (const u of users) if (!u.stopped) {
    const b = await balance(u);
    if (b !== null) { u.balance = b; u.spent = 0; }
    if (b !== null && b < MIN_BALANCE) { u.stopped = "low_balance"; out("LOADGEN_EVENT", { type: "user_stopped", user: u.name, reason: "low_balance", balance: Math.round(b) }); }
  }
}, 60_000).unref();

const endAt = START_AT + schedule.durationSec * 1000;
if (Date.now() < START_AT) await sleep(START_AT - Date.now());
const runStarted = Date.now();
let lastTickCalls = 0;
let downTicks = 0;
const governor = new RateGovernor({
  mode: schedule.adaptive ? "adaptive" : "schedule",
  maxRate: schedule.cap / MACHINES,
  minRate: MIN_RATE,
  startRate: schedule.adaptive ? schedule.startRate / MACHINES : null,
  breach: schedule.breach,
  ...(schedule.target ? { target: schedule.target } : {}),
});
let rate = governor.rate;
/** Models some active buyer may use: what slot utilization is measured over. */
function usableKeys() {
  const active = users.filter((u) => !u.stopped);
  return Object.keys(planner.netCap).filter((k) => k !== "auto" && active.some((u) => !u.avoid.has(k)));
}
// Slot utilization once a second, for the sustain profile's controller and the stage lines.
setInterval(() => {
  const u = planner.utilization(usableKeys());
  governor.sample(u);
  if (current && !current.endMs) {
    current.rateSum = (current.rateSum ?? 0) + rate;
    current.rateN = (current.rateN ?? 0) + 1;
    if (u !== null) { current.utilSum = (current.utilSum ?? 0) + u; current.utilN = (current.utilN ?? 0) + 1; }
  }
}, 1_000).unref();
const gapMs = (r) => (r > 0 ? (-Math.log(1 - R()) / r) * 1000 : 1000);

for (const st of schedule.stages) {
  const stageStart = START_AT + st.startSec * 1000;
  const stageEnd = stageStart + st.seconds * 1000;
  if (Date.now() >= stageEnd || stopReason) continue; // joined late, or stopped
  if (ADMIN_TOKEN) {
    const cap = await fetchCapacity(ADMIN_TOKEN).catch(() => null);
    if (cap) planner.setCapacity(cap);
  }
  out("LOADGEN_CAPACITY", { stage: st.index, source: ADMIN_TOKEN ? "admin_network" : initialCapacity ? "snapshot" : "defaults", snapshotAt: planner.capacity?.atMs ? new Date(planner.capacity.atMs).toISOString() : null, models: planner.view() });
  rate = governor.setStage(st.rate / MACHINES);
  lastTickCalls = 0;
  current = new StageStats({ index: st.index, rate });
  current.startMs = Math.max(Date.now(), stageStart);
  stageStats.push(current);
  let nextTick = Date.now() + 10_000;
  let nextArrival = Date.now() + gapMs(rate);
  out("LOADGEN_EVENT", { type: "stage_start", stage: st.index, networkRate: Math.round(rate * MACHINES * 100) / 100, machineRate: Math.round(rate * 100) / 100, ceiling: Number.isFinite(governor.ceiling) ? Math.round(governor.ceiling * 100) / 100 : null });
  while (Date.now() < stageEnd && !stopReason) {
    await sleep(Math.min(stageEnd, nextArrival, nextTick) - Date.now());
    if (Date.now() >= stageEnd || stopReason) break;
    if (Date.now() >= nextArrival) {
      if (rate > 0) arrival(current);
      nextArrival = Date.now() + gapMs(rate);
    }
    if (Date.now() >= nextTick) {
      nextTick += 10_000;
      const now = Date.now();
      while (recent.length && now - recent[0].atMs > 30_000) recent.shift();
      const errs = recent.filter((x) => x.error).length;
      const byType = {};
      for (const x of recent) if (x.type) byType[x.type] = (byType[x.type] ?? 0) + 1;
      const util = planner.utilization(usableKeys());
      out("LOADGEN_TICK", { stage: st.index, machineRate: Math.round(rate * 100) / 100, util: util === null ? null : Math.round(util * 1000) / 1000, inflight, waiting, calls: current.all.calls - lastTickCalls, ok: current.all.ok, errors30s: errs, calls30s: recent.length, dropped: current.dropped, inflightByModel: planner.inflight, penalties: planner.penalty, cSats: Math.round(machineSpent * 1000) / 1000, readySessions: readySessions.length });
      lastTickCalls = current.all.calls;
      // Capacity trouble never stops the run: the governor steps the rate down and holds it.
      const ch = governor.observe({ calls: recent.length, failures: errs });
      if (ch) {
        if (ch.action === "backoff") recent.length = 0;
        if (ch.action !== "hold" || ch.rate !== rate) out("LOADGEN_EVENT", { type: "rate", stage: st.index, ...ch, from: Math.round(ch.from * 1000) / 1000, rate: Math.round(ch.rate * 1000) / 1000, networkRate: Math.round(ch.rate * MACHINES * 100) / 100, ...(ch.ceiling !== undefined ? { ceiling: Math.round(ch.ceiling * 1000) / 1000 } : {}) });
        rate = ch.rate;
        nextArrival = Math.min(nextArrival, Date.now() + gapMs(rate));
      }
      // Only real failure stops it: auth refused, or the coordinator down for two minutes.
      const f = fatalStop({ calls: recent.length, errors: byType }, downTicks);
      downTicks = f.downTicks;
      if (f.stop && !stopReason) stopReason = f.stop;
    }
  }
  current.endMs = Math.min(Date.now(), stageEnd);
  if (current.rateN) current.rate = current.rateSum / current.rateN;
  const d = digestStage(current.toJSON());
  out("LOADGEN_STAGE", { ...d, inflightAtEnd: inflight, note: "calls still in flight are added in LOADGEN_STAGE_FINAL" });
  if (Date.now() >= endAt) break;
}

stopReason ??= "schedule_complete";
out("LOADGEN_EVENT", { type: "stopping", reason: stopReason, inflight });
// Drain: let calls in flight finish (at most 5 minutes, the coding-call timeout).
const drainUntil = Date.now() + 300_000;
while (inflight > 0 && Date.now() < drainUntil) await sleep(1_000);

const finals = stageStats.map((s) => s.toJSON());
for (const s of finals) {
  save({ type: "stage", stage: s });
  out("LOADGEN_STAGE_FINAL", digestStage(s));
}
const digests = finals.map(digestStage);
const summary = {
  type: "summary", profile: PROFILE, stopReason, startedAt: new Date(runStarted).toISOString(), endedAt: new Date().toISOString(),
  calls: digests.reduce((a, d) => a + d.calls, 0), cSatsSpent: Math.round(machineSpent * 1000) / 1000,
  rate: { final: Math.round(rate * 1000) / 1000, ceiling: Number.isFinite(governor.ceiling) ? Math.round(governor.ceiling * 1000) / 1000 : null, breaches: governor.breaches },
  shared: SHARED,
  users: users.map((u) => ({ name: u.name, persona: u.persona, stopped: u.stopped, avoid: [...u.avoid], money: { ...u.money, cSats: Math.round(u.money.cSats * 1000) / 1000 } })),
};
save(summary);
out("LOADGEN_SUMMARY", summary);
console.log(`\n${table(digests)}\n`);
if (LINGER_SEC) {
  out("LOADGEN_EVENT", { type: "linger", seconds: LINGER_SEC, note: "results stay readable until then; collect with scripts/loadgen/report.mjs" });
  await sleep(LINGER_SEC * 1000);
}
process.exit(0);
