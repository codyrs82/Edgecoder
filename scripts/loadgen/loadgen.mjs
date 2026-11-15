#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder, LLC
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
 *   - backoff: if the error rate over 30 s passes the profile's threshold, the rate drops one
 *     stage for the rest of the stage and the run then stops; a second breach stops it at once.
 *   - budget: a user stops below LOADGEN_MIN_BALANCE cSats; the machine stops after its share of
 *     LOADGEN_BUDGET_CSATS.
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
import { HARD_MAX_RATE, PERSONAS, MODELS, CODING_CONTEXT, buildSchedule, parseDuration } from "./profiles.mjs";
import { StageStats, classifyError, digestStage, isLoadError, table } from "./stats.mjs";
import { CodingSession, pickWeighted, question, rng } from "./workload.mjs";

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
const MAX_INFLIGHT = Number(opt("max-inflight", "LOADGEN_MAX_INFLIGHT", 48));
const LINGER_SEC = Number(opt("linger", "LOADGEN_LINGER_SEC", 0));
const RESULTS = opt("results", "LOADGEN_RESULTS", join(tmpdir(), `loadgen-${RUN_ID}-${REGION}.jsonl`));
const DRY = flag("dry-run") === "true";
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
const only = (opt("users", "LOADGEN_USERS", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const names = Object.keys(allKeys).filter((n) => !only.length || only.includes(n)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
const personaNames = Object.keys(PERSONAS);
const users = names
  .map((name, j) => ({ name, j }))
  .filter(({ j }) => j % MACHINES === INDEX)
  .map(({ name, j }) => ({ name, key: allKeys[name], persona: personaNames[j % personaNames.length], balance: null, spent: 0, stopped: null, sessions: 0 }));

out("LOADGEN_START", {
  profile: PROFILE, url: URL_, machines: MACHINES, index: INDEX, perSecondLimit: PER_SECOND_LIMIT, networkCap: schedule.cap,
  startAt: new Date(START_AT).toISOString(), durationSec: schedule.durationSec, loop: schedule.loop,
  stages: schedule.stages.map((s) => ({ i: s.index, rate: s.rate, sec: s.seconds })), breach: schedule.breach,
  users: users.map((u) => ({ name: u.name, persona: u.persona })), budgetCSats: BUDGET / MACHINES, minBalance: MIN_BALANCE, results: RESULTS,
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
 */
async function chatCall(u, body, { timeoutMs, sessionId }) {
  const t0 = performance.now();
  let ttft = null, text = "", status = 0, errBody = "", cSats = 0, usage = null, where = null;
  const toolCalls = [];
  try {
    const res = await fetch(`${URL_}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${u.key}`, "content-type": "application/json", "user-agent": UA,
        ...(sessionId ? { "x-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ ...body, stream: true, temperature: 0, ...(sessionId ? { user: sessionId } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    if (!res.ok || !res.body) errBody = (await res.text().catch(() => "")).slice(0, 300);
    else {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          let j;
          try { j = JSON.parse(line.slice(6)); } catch { continue; }
          if (j.error) errBody = JSON.stringify(j.error).slice(0, 300);
          const d = j.choices?.[0]?.delta;
          if (d?.content) { if (ttft === null) ttft = performance.now() - t0; text += d.content; }
          if (d?.tool_calls?.length) { if (ttft === null) ttft = performance.now() - t0; toolCalls.push(...d.tool_calls); }
          if (j.usage) usage = j.usage;
          if (j.edgecoder?.cSatsSpent !== undefined) cSats = Number(j.edgecoder.cSatsSpent) || 0;
          if (j.edgecoder?.where) where = String(j.edgecoder.where);
        }
      }
    }
  } catch (e) {
    if (e?.name === "TimeoutError") status = "timeout";
    else if (!status) status = "network";
    errBody = String(e?.message ?? e).slice(0, 200);
  }
  const totalMs = Math.round(performance.now() - t0);
  const error = status === 200 && !errBody ? null : classifyError(status, errBody) ?? `http_${status}`;
  return {
    status, error, errDetail: error ? errBody.slice(0, 160) : undefined, ttftMs: ttft === null ? null : Math.round(ttft), totalMs, text, toolCalls,
    cSats, where, promptTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0,
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
const R = rng(Number.parseInt(RUN_ID.replace(/\D/g, "").slice(-8) || "1", 10) + INDEX * 7919);
let current = null; // StageStats of the stage now running
const stageStats = [];
let inflight = 0;
let stopReason = null;
let machineSpent = 0;
const recent = []; // { atMs, error } of finished calls, for the breach check (error = a load error)
const readySessions = []; // coding sessions waiting for their next turn
let seq = 0;
let debt = 0; // arrivals a burst already used (a burst of k calls stands for k arrivals)

function record(stats, u, behaviour, model, r, correct, extra = {}) {
  const res = { behaviour, model, error: r.error, ttftMs: r.ttftMs, totalMs: r.totalMs, correct, cSats: r.cSats, promptTokens: r.promptTokens, outputTokens: r.outputTokens, where: r.where };
  stats.add(res);
  recent.push({ atMs: Date.now(), error: isLoadError(r.error) });
  u.spent += r.cSats ?? 0;
  machineSpent += r.cSats ?? 0;
  // Every error while they are few, then every 20th (the stage lines carry the full counts).
  if (r.error && (process.env.LOADGEN_VERBOSE === "1" || stats.errLogged++ < 30 || stats.errLogged % 20 === 0)) out("LOADGEN_ERR", { user: u.name, behaviour, model, error: r.error, status: r.status, detail: r.errDetail, ...extra });
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

async function doChat(u, stats, behaviour) {
  const model = pickWeighted(MODELS[behaviour], R);
  const { q, ok } = question(seq++);
  await takeSlot();
  inflight++;
  try {
    const r = await chatCall(u, { model, max_tokens: 16, messages: [{ role: "user", content: q }] }, { timeoutMs: 120_000 });
    record(stats, u, behaviour, model, r, r.error ? null : ok(r.text));
  } finally { inflight--; }
}

async function doBurst(u, stats) {
  const k = 2 + Math.floor(R() * 4);
  debt += k - 1;
  await Promise.all(Array.from({ length: k }, () => doChat(u, stats, "burst")));
}

function newSession(u) {
  const model = pickWeighted(MODELS.coding, R);
  const full = CODING_CONTEXT[model] ?? CODING_CONTEXT.default;
  const target = Math.max(2_500, Math.round(full * schedule.codingContextScale));
  u.sessions++;
  return new CodingSession({ id: `${RUN_ID}-${REGION}-${u.name}-${randomUUID().slice(0, 8)}`, model, seed: Math.floor(R() * 2 ** 31), targetTokens: target, startTokens: 2_000, maxTurns: schedule.codingContextScale < 1 ? 4 : 12 });
}

async function doCodingTurn(u, s, stats) {
  const { messages, tools, contextTokens } = s.next();
  await takeSlot();
  inflight++;
  let r;
  try {
    r = await chatCall(u, { model: s.model, max_tokens: 64, messages, tools }, { timeoutMs: 300_000, sessionId: s.id });
  } finally { inflight--; }
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
  if (inflight >= MAX_INFLIGHT || waiting > PER_SECOND_LIMIT * 5) { stats.dropped++; return; }
  const now = Date.now();
  const ready = readySessions.findIndex((s) => s.readyAtMs <= now);
  if (ready >= 0) {
    const [s] = readySessions.splice(ready, 1);
    if (!s.user.stopped && !(s.user.pausedUntil > now)) { void doCodingTurn(s.user, s, stats); return; }
    s.user.sessions--;
  }
  const active = users.filter((u) => !u.stopped && !(u.pausedUntil > now));
  if (!active.length) {
    if (!users.some((u) => !u.stopped)) stopReason ??= "all_users_stopped";
    stats.dropped++;
    return;
  }
  const u = active[Math.floor(R() * active.length)];
  let b = pickWeighted(PERSONAS[u.persona], R);
  if (b === "coding" && u.sessions >= (u.persona === "coder" ? 2 : 1)) b = "chat";
  if (b === "coding") void doCodingTurn(u, newSession(u), stats);
  else if (b === "burst") void doBurst(u, stats);
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
let backedOff = false;
let lastTickCalls = 0;

for (const st of schedule.stages) {
  const stageStart = START_AT + st.startSec * 1000;
  const stageEnd = stageStart + st.seconds * 1000;
  if (Date.now() >= stageEnd || stopReason) continue; // joined late, or stopped
  current = new StageStats({ index: st.index, rate: st.rate / MACHINES });
  current.startMs = Math.max(Date.now(), stageStart);
  stageStats.push(current);
  let rate = st.rate / MACHINES;
  let breachedAt = 0;
  let nextTick = Date.now() + 10_000;
  out("LOADGEN_EVENT", { type: "stage_start", stage: st.index, networkRate: st.rate, machineRate: Math.round(rate * 100) / 100 });
  while (Date.now() < stageEnd && !stopReason) {
    const gap = rate > 0 ? -Math.log(1 - R()) / rate * 1000 : 1000;
    const wakeAt = Math.min(stageEnd, Date.now() + gap);
    await sleep(wakeAt - Date.now());
    if (Date.now() >= stageEnd || stopReason) break;
    if (rate > 0) arrival(current);
    if (Date.now() >= nextTick) {
      nextTick += 10_000;
      const now = Date.now();
      while (recent.length && now - recent[0].atMs > 30_000) recent.shift();
      const errs = recent.filter((x) => x.error).length;
      const errRate = recent.length ? errs / recent.length : 0;
      out("LOADGEN_TICK", { stage: st.index, machineRate: Math.round(rate * 100) / 100, inflight, waiting, calls: current.all.calls - lastTickCalls, ok: current.all.ok, errors30s: errs, calls30s: recent.length, dropped: current.dropped, cSats: Math.round(machineSpent * 1000) / 1000, readySessions: readySessions.length });
      lastTickCalls = current.all.calls;
      if (recent.length >= schedule.breach.minCalls && errRate > schedule.breach.errorRate && now - breachedAt > 30_000) {
        if (!backedOff) {
          backedOff = true;
          breachedAt = now;
          const prev = st.index > 0 ? schedule.stages[st.index - 1].rate / MACHINES : rate / 2;
          rate = Math.min(rate, prev);
          recent.length = 0;
          out("LOADGEN_EVENT", { type: "backoff", stage: st.index, errorRate: Math.round(errRate * 1000) / 1000, newMachineRate: Math.round(rate * 100) / 100, note: "holding the lower rate to the end of this stage, then stopping" });
        } else {
          stopReason = `error_rate_${Math.round(errRate * 100)}pct_after_backoff`;
        }
      }
    }
  }
  current.endMs = Math.min(Date.now(), stageEnd);
  const d = digestStage(current.toJSON());
  out("LOADGEN_STAGE", { ...d, inflightAtEnd: inflight, note: "calls still in flight are added in LOADGEN_STAGE_FINAL" });
  if (backedOff && !stopReason) stopReason = "stopped_after_backoff";
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
  users: users.map((u) => ({ name: u.name, persona: u.persona, stopped: u.stopped })),
};
save(summary);
out("LOADGEN_SUMMARY", summary);
console.log(`\n${table(digests)}\n`);
if (LINGER_SEC) {
  out("LOADGEN_EVENT", { type: "linger", seconds: LINGER_SEC, note: "results stay readable until then; collect with scripts/loadgen/report.mjs" });
  await sleep(LINGER_SEC * 1000);
}
process.exit(0);
