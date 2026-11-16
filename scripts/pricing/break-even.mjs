// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Host break-even and profit for model calls, and the prices that make every host class profitable.
 *
 *   node scripts/pricing/break-even.mjs [--btc-usd 64870] [--out break-even.json]
 *
 * Owner's target (2026-11-16): every real host class makes PROFIT_MARGIN (20 %) over its cost at
 * TARGET_UTILIZATION (50 %), after the network fee (the host keeps 95 %), on MEASURED throughput
 * (Ollama, today's slots), not on assumed vLLM gains.
 *
 *   needed revenue of a fully busy hour = (1 + PROFIT_MARGIN) × hostCostUsdPerHour / (0.95 × TARGET_UTILIZATION)
 *
 * Utilization = the share of the hour the host's slots serve calls (the coordinator's slot-busy
 * figure); revenue at u = u × the revenue of a fully busy hour. A model call costs
 * max(tokens × band price, power floor for its seconds ÷ the agent's slots)
 * (src/economy/job-pricing.ts), approximated per host as
 * max(token revenue, floor × tier weight × concurrent calls ÷ slots).
 *
 * The levers: per-token band prices for GPU / large models (one multiplier on the 30B-and-up
 * bands, set by the costliest target host), and the class power floor for CPU and Mac hosts (the
 * floor's documented purpose: electricity). The script prints what each lever must be; the code
 * (TOKEN_PRICE_USD_PER_M, POWER_FLOOR_USD_PER_HOUR) carries the result, and
 * tests/pricing/break-even.test.ts checks the two agree.
 *
 * Every input is meant to be edited. Measured values come from the 60-minute sustained load run
 * lg-202611160219-sustain (iad, 2026-11-16); anything not measured says so.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Host keeps 95 %, the network fee is 5 % (NETWORK_FEE_BPS = 500). */
export const HOST_SHARE = 0.95;
/** Profit over cost a target host makes at TARGET_UTILIZATION (HOST_PROFIT_MARGIN in job-pricing.ts). */
export const PROFIT_MARGIN = 0.2;
export const TARGET_UTILIZATION = 0.5;

/** Host cost per hour (USD). Edit freely. */
export const HOST_COSTS = {
  a16x2: { label: "Vultr 2×A16 (vcg-a16-12c-120g-32vram)", usdPerHour: 1.0, source: "owner-stated $1.00/h (Vultr plans API lists $0.942/h)" },
  a100: { label: "Vultr A100 80GB (vcg-a100-12c-120g-80vram)", usdPerHour: 2.397, source: "Vultr public plans API (api.vultr.com/v2/plans), $1,750/mo, read 2026-11-15" },
  mac: {
    label: "Mac Studio M1 Max (home)",
    watts: 90, // 60-120 W under load
    usdPerKwh: 0.15, // assumption
    depreciationUsdPerHour: 2000 / (3 * 8760), // assumption: $2,000 over 3 years, 24/7; reported, not targeted
    source: "electricity 90 W × $0.15/kWh (assumed); depreciation reported only",
  },
  homeCpu: { label: "Home CPU desktop", watts: 65, usdPerKwh: 0.15, source: "electricity only, 65 W × $0.15/kWh (assumed)" },
  flyCpu: { label: "Fly shared-cpu agent (EdgeCoder test fleet)", usdPerHour: 0.035, source: "owner range $0.02-0.05/h" },
};

export function hostCostUsdPerHour(key, { withDepreciation = false } = {}) {
  const h = HOST_COSTS[key];
  if (h.usdPerHour !== undefined) return h.usdPerHour;
  return (h.watts / 1000) * h.usdPerKwh + (withDepreciation ? h.depreciationUsdPerHour ?? 0 : 0);
}

/**
 * Prices and floors: `before` = the code before 2026-11-16 (every concurrent call paid the whole
 * floor); `now` = the code now (mirrors TOKEN_PRICE_USD_PER_M and POWER_FLOOR_USD_PER_HOUR).
 */
export const PRICES = {
  before: {
    bands: [
      { maxB: 2, input: 0.01, output: 0.03 },
      { maxB: 4, input: 0.02, output: 0.05 },
      { maxB: 9, input: 0.04, output: 0.1 },
      { maxB: 16, input: 0.07, output: 0.2 },
      { maxB: 35, input: 0.12, output: 0.35 },
      { maxB: 80, input: 0.3, output: 0.8 },
      { maxB: Infinity, input: 0.6, output: 1.5 },
    ],
    floor: { cpu: 0.005, apple: 0.01, gpu: 0.05, "gpu.dc": 0.15 },
    splitBySlots: false,
  },
  now: {
    bands: [
      { maxB: 2, input: 0.01, output: 0.03 },
      { maxB: 4, input: 0.02, output: 0.05 },
      { maxB: 9, input: 0.04, output: 0.1 },
      { maxB: 16, input: 0.07, output: 0.2 },
      { maxB: 35, input: 1.05, output: 3.05 },
      { maxB: 80, input: 2.6, output: 6.95 },
      { maxB: Infinity, input: 5.2, output: 13.0 },
    ],
    floor: { cpu: 0.025, apple: 0.014, gpu: 0.05, "gpu.dc": 0.15 },
    splitBySlots: true,
  },
};

/** Bands priced by the large-model multiplier (30B class and up). */
export const LARGE_BAND_MIN_B = 17;

/** Measured, per model (sustained run lg-202611160219-sustain, iad). Successful calls only. busy = slot-busy share. */
export const MEASURED = {
  "qwen3-coder:30b": { paramsB: 30, seconds: 3600, calls: 526, prompt: 1_494_390, output: 70_590, cSats: 320.373, hosts: 1, busy: 0.698, note: "2×A16, Ollama, 1 slot, 64K ctx" },
  "qwen3.5:9b": { paramsB: 9, seconds: 3600, calls: 406, prompt: 1_064_354, output: 71_628, cSats: 109.035, hosts: 2, busy: 0.576, note: "2 Macs, 4 Ollama slots each" },
  "qwen2.5-coder:7b": { paramsB: 7, seconds: 300, calls: 61, prompt: 134_606, output: 6_151, cSats: 9.557, hosts: 1, busy: 0.9, note: "first 5 min only (the Mac left after); busy 0.9 ASSUMED" },
  "qwen2.5-coder:1.5b": { paramsB: 1.5, seconds: 3600, calls: 49, prompt: 15_519, output: 3_741, cSats: 3.447, hosts: 11, busy: 0.009, note: "CPU fleet nearly idle; seconds per call derived from the power floor billed" },
};

/**
 * Scenarios: a host running one model. `target`: must reach PROFIT_MARGIN at TARGET_UTILIZATION.
 * `speedup` scales the measured throughput (values other than 1 are ASSUMPTIONS). `concurrency`
 * = calls running at once when fully busy.
 */
export const SCENARIOS = [
  { id: "a16-ollama-1", model: "qwen3-coder:30b", host: "a16x2", runtime: "Ollama", slots: 1, ctx: "64K", speedup: 1, concurrency: 1, computeClass: "gpu.dc", tierWeight: 1, target: true, measured: true },
  { id: "a100-ollama-1", model: "qwen3-coder:30b", host: "a100", runtime: "Ollama", slots: 1, ctx: "64K", speedup: 6, concurrency: 1, computeClass: "gpu.dc", tierWeight: 2.9, target: true, assumption: "no measured A100 run: one A100 Ollama slot assumed 6× the 2×A16 slot (~10× the memory bandwidth of one A16 GPU)" },
  { id: "mac-9b", model: "qwen3.5:9b", host: "mac", runtime: "Ollama", slots: 4, ctx: "-", speedup: 1, concurrency: 4, computeClass: "apple", tierWeight: 2.5, target: true, measured: true },
  { id: "mac-7b", model: "qwen2.5-coder:7b", host: "mac", runtime: "Ollama", slots: 4, ctx: "-", speedup: 1, concurrency: 4, computeClass: "apple", tierWeight: 2.5, target: true, measured: true, assumption: "busy share assumed 0.9" },
  { id: "mac-14b", model: "qwen3.5:9b", paramsB: 14, host: "mac", runtime: "Ollama", slots: 4, ctx: "-", speedup: 9 / 14, concurrency: 4, computeClass: "apple", tierWeight: 2.5, target: true, assumption: "no successful 14B call in the run: 9B throughput × 9/14" },
  { id: "home-cpu-1.5b", model: "qwen2.5-coder:1.5b", host: "homeCpu", runtime: "Ollama", slots: 2, ctx: "-", speedup: 1, concurrency: 2, computeClass: "cpu", tierWeight: 1, target: true, measured: true, cpuFloorDerived: true },
  // Not targeted: assumed vLLM gains (what the same prices pay once vLLM's slots land) ...
  { id: "a16-vllm-2", model: "qwen3-coder:30b", host: "a16x2", runtime: "vLLM", slots: 2, ctx: "64K", speedup: 1.8, concurrency: 2, computeClass: "gpu.dc", tierWeight: 1, assumption: "2 slots assumed 1.8× aggregate" },
  { id: "a16-vllm-4", model: "qwen3-coder:30b", host: "a16x2", runtime: "vLLM", slots: 4, ctx: "40K", speedup: 3, concurrency: 4, computeClass: "gpu.dc", tierWeight: 1, assumption: "4 slots assumed 3× aggregate" },
  { id: "a16-vllm-5", model: "qwen3-coder:30b", host: "a16x2", runtime: "vLLM", slots: 5, ctx: "32K", speedup: 3.5, concurrency: 5, computeClass: "gpu.dc", tierWeight: 1, assumption: "5 slots assumed 3.5× aggregate" },
  { id: "a100-vllm-12", model: "qwen3-coder:30b", host: "a100", runtime: "vLLM", slots: 12, ctx: "32K", speedup: 20, concurrency: 12, computeClass: "gpu.dc", tierWeight: 2.9, assumption: "12 vLLM slots assumed 20× the 2×A16 Ollama slot" },
  // ... and EdgeCoder's own Fly test agents (edgecoder-agents), which are not a host business.
  { id: "fly-1.5b", model: "qwen2.5-coder:1.5b", host: "flyCpu", runtime: "Ollama", slots: 2, ctx: "-", speedup: 1, concurrency: 2, computeClass: "cpu", tierWeight: 1, measured: true, cpuFloorDerived: true, excluded: "EdgeCoder's own Fly test fleet, not a host business" },
];

/** Frontier list prices (USD per million tokens). Anthropic: claude-api skill model table (cached 2026-10-06). */
export const FRONTIER = [
  { name: "Claude Haiku 5.5", input: 0.1, output: 0.5 },
  { name: "Claude Sonnet 5.5", input: 2, output: 10 },
  { name: "hosted qwen3-coder-30b-a3b (OpenRouter, approx.)", input: 0.07, output: 0.27 },
];

export const bandFor = (bands, paramsB) => bands.find((r) => paramsB <= r.maxB) ?? bands[bands.length - 1];
export const usdToSats = (usd, btcUsd) => (usd / btcUsd) * 1e8;
export const satsToUsd = (sats, btcUsd) => (sats / 1e8) * btcUsd;
const ceilTo = (x, step) => Math.ceil(x / step - 1e-9) * step;
const paramsOf = (s) => s.paramsB ?? MEASURED[s.model].paramsB;

/** Revenue a fully busy hour must bring for PROFIT_MARGIN at TARGET_UTILIZATION. */
export const neededFullHourUsd = (costUsd, margin = PROFIT_MARGIN, u = TARGET_UTILIZATION) => ((1 + margin) * costUsd) / (HOST_SHARE * u);
/** Utilization at which revenue covers cost × (1 + margin) (Infinity when it can't). */
export const utilFor = (costUsd, fullUsd, margin = 0) => (fullUsd > 0 ? ((1 + margin) * costUsd) / (HOST_SHARE * fullUsd) : Infinity);

/** Per-call averages and the host's fully busy hour (calls, tokens). */
export function scenarioThroughput(s, btcUsd) {
  const m = MEASURED[s.model];
  const perCall = { prompt: m.prompt / m.calls, output: m.output / m.calls };
  let callsPerHourFull;
  if (s.cpuFloorDerived) {
    // These calls were billed at the old CPU floor (0.005 USD/h, unsplit), so the cSats give their seconds.
    const busySecondsPerCall = ((satsToUsd(m.cSats, btcUsd) / (PRICES.before.floor.cpu * s.tierWeight)) * 3600) / m.calls;
    callsPerHourFull = (s.concurrency * 3600) / busySecondsPerCall;
  } else {
    callsPerHourFull = ((m.calls * (3600 / m.seconds)) / m.hosts / m.busy) * s.speedup;
  }
  return { perCall, callsPerHourFull, tokensPerHourFull: { prompt: perCall.prompt * callsPerHourFull, output: perCall.output * callsPerHourFull } };
}

/** A fully busy hour's revenue (USD, before the fee) under a price set. */
export function fullHourRevenueUsd(s, t, prices) {
  const band = bandFor(prices.bands, paramsOf(s));
  const tokenUsd = (t.tokensPerHourFull.prompt * band.input + t.tokensPerHourFull.output * band.output) / 1e6;
  const floorUsd = ((prices.floor[s.computeClass] ?? prices.floor.cpu) * s.tierWeight * s.concurrency) / (prices.splitBySlots ? Math.max(1, s.slots) : 1);
  return { usd: Math.max(tokenUsd, floorUsd), basis: tokenUsd >= floorUsd ? "tokens" : "power_floor", tokenUsd, floorUsd };
}

export function analyse(s, btcUsd) {
  const cost = hostCostUsdPerHour(s.host);
  const t = scenarioThroughput(s, btcUsd);
  const before = fullHourRevenueUsd(s, t, PRICES.before);
  const now = fullHourRevenueUsd(s, t, PRICES.now);
  const dep = HOST_COSTS[s.host].depreciationUsdPerHour !== undefined ? hostCostUsdPerHour(s.host, { withDepreciation: true }) : undefined;
  const marginAt = (rev, u) => (HOST_SHARE * u * rev) / cost - 1;
  return {
    id: s.id,
    model: s.paramsB ? `${s.paramsB}B (from ${s.model})` : s.model,
    host: HOST_COSTS[s.host].label,
    runtime: `${s.runtime} ${s.slots} slot${s.slots === 1 ? "" : "s"}${s.ctx !== "-" ? ` @${s.ctx}` : ""}`,
    target: !!s.target,
    excluded: s.excluded ?? null,
    costUsdPerHour: cost,
    callsPerHourFull: t.callsPerHourFull,
    tokensPerHourFull: t.tokensPerHourFull,
    perCall: t.perCall,
    neededFullHourUsd: neededFullHourUsd(cost),
    fullHourRevenueUsd: { before: before.usd, now: now.usd },
    basis: { before: before.basis, now: now.basis },
    breakEvenUtil: { before: utilFor(cost, before.usd), now: utilFor(cost, now.usd) },
    profitUtil: { before: utilFor(cost, before.usd, PROFIT_MARGIN), now: utilFor(cost, now.usd, PROFIT_MARGIN) },
    marginAtTarget: { before: marginAt(before.usd, TARGET_UTILIZATION), now: marginAt(now.usd, TARGET_UTILIZATION) },
    breakEvenUtilWithDepreciation: dep === undefined ? null : utilFor(dep, now.usd),
    assumption: s.assumption ?? null,
    _t: t,
  };
}

/**
 * The levers that reach the target on every target host:
 * - large bands: one multiplier on the pre-2026-11-16 30B-and-up prices, the largest any target host
 *   on those bands needs from its tokens, each price rounded up to 0.05 USD;
 * - power floors per class (CPU, Mac): what a target host needs from the floor alone, split per
 *   slot, rounded up to 0.001 USD/h. Bands ≤16B keep their prices when the Mac's tokens reach the target.
 */
export function recommend(btcUsd) {
  let multiplier = 0;
  const floors = {};
  const smallBands = [];
  for (const s of SCENARIOS.filter((x) => x.target)) {
    const cost = hostCostUsdPerHour(s.host);
    const need = neededFullHourUsd(cost);
    const t = scenarioThroughput(s, btcUsd);
    const pB = paramsOf(s);
    const oldTok = fullHourRevenueUsd(s, t, PRICES.before).tokenUsd;
    if (pB >= LARGE_BAND_MIN_B) multiplier = Math.max(multiplier, need / oldTok);
    else {
      const perFloorUnit = (s.tierWeight * s.concurrency) / Math.max(1, s.slots);
      floors[s.computeClass] = Math.max(floors[s.computeClass] ?? 0, need / perFloorUnit);
      const nowTok = fullHourRevenueUsd(s, t, PRICES.now).tokenUsd;
      smallBands.push({ id: s.id, paramsB: pB, tokensReachTarget: nowTok >= need, tokenMarginAtTarget: (HOST_SHARE * TARGET_UTILIZATION * nowTok) / cost - 1 });
    }
  }
  const bands = PRICES.before.bands.map((b) =>
    b.maxB >= LARGE_BAND_MIN_B ? { maxB: b.maxB, input: Number(ceilTo(b.input * multiplier, 0.05).toFixed(2)), output: Number(ceilTo(b.output * multiplier, 0.05).toFixed(2)) } : { ...b }
  );
  const floor = { ...PRICES.before.floor };
  for (const [c, v] of Object.entries(floors)) floor[c] = Number(ceilTo(v, 0.001).toFixed(3));
  return { multiplier, bands, floor, rawFloors: floors, smallBands };
}

/** What a buyer pays for a typical call of each measured model, before and now, and frontier list prices. */
export function buyerImpact(btcUsd) {
  return Object.entries(MEASURED).map(([model, m]) => {
    const perCall = { prompt: m.prompt / m.calls, output: m.output / m.calls };
    const s = SCENARIOS.find((x) => x.model === model && x.target && !x.paramsB);
    const tok = (bands) => {
      const b = bandFor(bands, m.paramsB);
      return (perCall.prompt * b.input + perCall.output * b.output) / 1e6;
    };
    const measuredUsd = satsToUsd(m.cSats / m.calls, btcUsd);
    // Measured cost = max(tokens, old floor). The floor part scales by the new floor ÷ the old and is split over the slots.
    const floorScale = PRICES.now.floor[s.computeClass] / PRICES.before.floor[s.computeClass] / Math.max(1, s.slots);
    const beforeUsd = Math.max(measuredUsd, tok(PRICES.before.bands));
    const nowUsd = Math.max(tok(PRICES.now.bands), measuredUsd > tok(PRICES.before.bands) * 1.001 ? measuredUsd * floorScale : 0);
    const frontier = Object.fromEntries(FRONTIER.map((f) => [f.name, ((perCall.prompt * f.input + perCall.output * f.output) / 1e6) * 1000]));
    return { model, perCall, sats: { before: usdToSats(beforeUsd, btcUsd), now: usdToSats(nowUsd, btcUsd) }, usdPer1000: { before: beforeUsd * 1000, now: nowUsd * 1000 }, frontierUsdPer1000: frontier };
  });
}

async function liveBtcUsd() {
  // The rate oracle's first source (src/economy/rate-oracle.ts DEFAULT_BTC_USD_SOURCES).
  const r = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", { signal: AbortSignal.timeout(10_000) });
  const n = Number((await r.json())?.data?.amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error("no BTC price");
  return n;
}

const f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "never");
const pct = (u) => (!Number.isFinite(u) ? "never" : u <= 1 ? `${Math.round(u * 100)}%` : `never (${Math.round(u * 100)}%)`);

function printTables(out) {
  const L = (s = "") => console.log(s);
  L(`BTC/USD ${out.btcUsd} (${out.btcSource}); host keeps ${HOST_SHARE * 100}%; target ${PROFIT_MARGIN * 100}% profit at ${TARGET_UTILIZATION * 100}% utilization`);
  L();
  L("scenario         | target | host $/h | calls/h@100% | revenue/h@100% before -> now | break-even before -> now | profit util now | margin at 50% now");
  for (const r of out.scenarios) {
    const tag = r.excluded ? "excl." : r.target ? "yes" : "info";
    L(
      `${r.id.padEnd(16)} | ${tag.padEnd(6)} | ${f(r.costUsdPerHour, 4).padStart(8)} | ${f(r.callsPerHourFull, 0).padStart(12)} | ${`$${f(r.fullHourRevenueUsd.before, 4)} -> $${f(r.fullHourRevenueUsd.now, 4)} (${r.basis.now})`.padEnd(30)} | ${`${pct(r.breakEvenUtil.before)} -> ${pct(r.breakEvenUtil.now)}`.padEnd(24)} | ${pct(r.profitUtil.now).padEnd(15)} | ${f(r.marginAtTarget.now * 100, 0)}%${r.breakEvenUtilWithDepreciation !== null ? `  (with depreciation: break-even ${pct(r.breakEvenUtilWithDepreciation)})` : ""}${r.assumption ? "  *" : ""}`
    );
  }
  L("* throughput or slots assumed, see JSON 'assumption'");
  L();
  const rec = out.recommended;
  L(`Recommended: large-band multiplier ${f(rec.multiplier, 3)}× on the old 30B-and-up prices; floors ${JSON.stringify(rec.floor)}`);
  for (const b of rec.bands) L(`  ≤${b.maxB === Infinity ? "∞" : b.maxB}B  ${f(b.input)} / ${f(b.output)} USD per M tokens`);
  for (const sb of rec.smallBands) L(`  ${sb.id} (${sb.paramsB}B band): tokens at today's band price ${sb.tokensReachTarget ? "reach" : "do NOT reach"} the target (margin ${f(sb.tokenMarginAtTarget * 100, 0)}% at 50%)`);
  L();
  L("Buyer: sats per typical call and USD per 1,000 calls, before -> now; frontier list prices for the same tokens");
  for (const b of out.buyerImpact) {
    const fr = Object.entries(b.frontierUsdPer1000).map(([k, v]) => `${k} $${f(v, 3)}`).join("; ");
    L(`${b.model.padEnd(20)} ${f(b.perCall.prompt, 0)} in / ${f(b.perCall.output, 0)} out | sats/call ${f(b.sats.before, 3)} -> ${f(b.sats.now, 3)} | $/1k ${f(b.usdPer1000.before, 3)} -> ${f(b.usdPer1000.now, 3)} | ${fr}`);
  }
}

export async function run(argv = process.argv.slice(2)) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  let btcUsd = Number(arg("--btc-usd"));
  let btcSource = "--btc-usd";
  if (!Number.isFinite(btcUsd) || btcUsd <= 0) {
    try {
      btcUsd = await liveBtcUsd();
      btcSource = "Coinbase spot, the rate oracle's first source";
    } catch {
      btcUsd = 100_000;
      btcSource = "fallback (FALLBACK_BTC_USD); pass --btc-usd";
    }
  }
  const out = {
    generatedAt: new Date().toISOString(),
    btcUsd,
    btcSource,
    hostShare: HOST_SHARE,
    profitMargin: PROFIT_MARGIN,
    targetUtilization: TARGET_UTILIZATION,
    inputs: { HOST_COSTS, PRICES, MEASURED, SCENARIOS },
    scenarios: SCENARIOS.map((s) => {
      const { _t, ...r } = analyse(s, btcUsd);
      return r;
    }),
    recommended: recommend(btcUsd),
    buyerImpact: buyerImpact(btcUsd),
  };
  printTables(out);
  const file = resolve(arg("--out") ?? "break-even.json");
  writeFileSync(file, JSON.stringify(out, (_k, v) => (v === Infinity ? "Infinity" : v), 2));
  console.log(`\nwrote ${file}`);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
